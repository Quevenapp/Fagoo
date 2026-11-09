"""Minimal transport consumer for the versioned Hermes exclusive-ingress contract."""
from __future__ import annotations
import asyncio
import json
import mimetypes
import sqlite3
import time
from urllib.parse import unquote, quote
import hashlib
from pathlib import Path
try:
    from .content import features, send_native
except ImportError:
    import importlib.util
    _spec = importlib.util.spec_from_file_location("wabotia_native_content", Path(__file__).with_name("content.py"))
    _module = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_module)
    features, send_native = _module.features, _module.send_native
import httpx


def register(ctx):
    from hermes_constants import get_hermes_home
    from gateway.exclusive_ingress import register_consumer, CONTRACT_VERSION
    if CONTRACT_VERSION != 1:
        raise RuntimeError('Unsupported exclusive-ingress contract')
    worker = Transport(get_hermes_home())
    register_consumer(ctx, worker.receive, worker.tick)
    ctx.on_unload(worker.close)


class Transport:
    def __init__(self, home):
        self.home = Path(home)
        cfg = json.loads((self.home / 'wabotia-connector.json').read_text())
        if not cfg['url'].startswith('https://'):
            raise ValueError('Wabotia requires HTTPS')
        self.cfg = cfg
        self.root = self.home / 'wabotia-transport'
        self.root.mkdir(mode=0o700, exist_ok=True)
        self.db = sqlite3.connect(self.root / 'journal.sqlite')
        self.db.executescript("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,status TEXT,external_id TEXT,error TEXT,reported INTEGER DEFAULT 0); CREATE TABLE IF NOT EXISTS media(path TEXT PRIMARY KEY,id TEXT);")
        self.db.execute("UPDATE commands SET status='unknown',error='Interrupted during send' WHERE status='sending'")
        self.db.commit()
        self.task = None
        self.closed = False
        self.last_status = 0
        self.last_template = 0

    def close(self):
        self.closed = True
        if self.task:
            self.task.cancel()

    async def request(self, route, *, body=None, files=None, content=None, headers=None):
        async with httpx.AsyncClient(timeout=120, follow_redirects=False, trust_env=False) as client:
            response = await client.request('POST' if body is not None or files or content is not None else 'GET',
                self.cfg['url'].rstrip('/') + '/internal/v1/connectors/' + self.cfg['connection_id'] + route,
                headers={'Authorization': 'Bearer ' + self.cfg['token'], 'User-Agent': 'Wabotia-Connector/0.5', **(headers or {})}, json=body, files=files, content=content)
            response.raise_for_status()
            return response

    async def receive(self, payload, host):
        if payload['platform'] != self.cfg['platform'] or payload['chat_type'] not in ('dm', 'group'):
            return True  # Reserved group/system traffic must never fall through to an agent.
        attachments = []
        for media in payload.get('media', []):
            source = Path(media['path'])
            known = self.db.execute('SELECT id FROM media WHERE path=?', (str(source),)).fetchone()
            if known:
                attachments.append(known[0])
                continue
            if source.is_symlink() or not source.is_file() or source.stat().st_size > 100*1024*1024:
                payload['text'] += '\n[Attachment unavailable; human review required]'
                continue
            async def chunks():
                with source.open('rb') as handle:
                    while chunk := handle.read(1024*1024):
                        yield chunk
            response = await self.request('/media-content', content=chunks(), headers={
                'Content-Type': mimetypes.guess_type(source.name)[0] or 'application/octet-stream',
                'Content-Length': str(source.stat().st_size), 'X-Filename': quote(source.name),
                'Idempotency-Key': hashlib.sha256((payload['message_id']+str(source)).encode()).hexdigest()})
            media_id = response.json()['id']
            self.db.execute('INSERT OR REPLACE INTO media VALUES(?,?)', (str(source), media_id))
            self.db.commit()
            attachments.append(media_id)
        metadata = payload.get('metadata') or {}
        source = payload.get('source') or {}
        media = payload.get('media') or []
        mime = mimetypes.guess_type(media[0]['path'])[0] if media else None
        kind = ('image' if mime and mime.startswith('image/') else 'video' if mime and mime.startswith('video/') else 'audio' if mime and mime.startswith('audio/') else 'document') if media else 'text'
        await self.request('/events', body={'external_id': payload['chat'], 'phone': None if payload['chat_type'] == 'group' else payload['user'],
            'message_id': payload['message_id'], 'text': payload.get('text', ''), 'attachments': attachments,
            'chat_type': 'group' if payload['chat_type'] == 'group' else 'direct', 'title': source.get('chat_name', ''),
            'content': {'type': kind, 'participant': payload['user'], 'participant_name': source.get('user_name') or payload['user'],
                        'reply_external_id': payload.get('reply_to'), 'mentioned': bool(metadata.get('wabotia_mentioned'))}})
        return True

    async def tick(self, host):
        if not self.closed and (not self.task or self.task.done()):
            if self.task:
                try:
                    self.task.result()
                except (Exception, asyncio.CancelledError):
                    pass
            self.task = asyncio.create_task(self.loop(host), name='wabotia-transport')

    async def receipt(self, row):
        await self.request('/receipts', body=dict(zip(('id','status','external_id','error'), row[:4])))
        self.db.execute('UPDATE commands SET reported=1 WHERE id=?', (row[0],))
        self.db.commit()

    async def loop(self, host):
        while not self.closed:
            try:
                adapter = host.adapter(self.cfg['platform'])
                if not adapter or not adapter.is_connected:
                    await asyncio.sleep(5)
                    continue
                if time.time() - self.last_status > 30:
                    status = {'state': 'connected', 'platform': self.cfg['platform'], 'protocol_version': 2, 'features': features(adapter, self.cfg['platform'])}
                    if self.cfg['platform'] == 'whatsapp_cloud' and time.time() - self.last_template > 3600:
                        policy = (await self.request('/policy')).json()['notifications']
                        if policy.get('enabled') and policy.get('template_name') and adapter._waba_id:
                            async with httpx.AsyncClient(timeout=120, follow_redirects=False) as client:
                                catalog = await client.get(f'https://graph.facebook.com/{adapter._api_version}/{adapter._waba_id}/message_templates', params={'name': policy['template_name']}, headers=adapter._auth_headers())
                                catalog.raise_for_status()
                                template = next((t for t in catalog.json().get('data', []) if t.get('name') == policy['template_name'] and t.get('language') == policy.get('language')), None)
                                if template:
                                    status['approved_template'] = {k: template[k] for k in ('name','language','status','category','components') if k in template}
                        self.last_template = time.time()
                    await self.request('/status', body=status)
                    self.last_status = time.time()
                for row in self.db.execute("SELECT * FROM commands WHERE status IN ('sent','unknown','failed') AND reported=0").fetchall():
                    await self.receipt(row)
                response = await self.request('/commands')
                for command in response.json()['commands']:
                    old = self.db.execute('SELECT * FROM commands WHERE id=?', (command['id'],)).fetchone()
                    if old:
                        await self.receipt(old)
                        continue
                    if not (await self.request('/commands/'+command['id']+'/check', body={})).json()['valid']:
                        continue
                    self.db.execute("INSERT INTO commands(id,status) VALUES(?,'sending')", (command['id'],))
                    self.db.commit()
                    try:
                        payload, chat = command['payload'], command['destination']
                        media_id = payload.get('media_id')
                        target = None
                        if media_id:
                            media = await self.request('/media/'+media_id)
                            filename = unquote(media.headers.get('X-Filename', 'anexo'))
                            target = self.root / ('out-'+command['id']+Path(filename).suffix[:12])
                            target.write_bytes(media.content)
                            target.chmod(0o600)
                        if not (await self.request('/commands/'+command['id']+'/check', body={})).json()['valid']:
                            self.db.execute("UPDATE commands SET status='cancelled',reported=1 WHERE id=?", (command['id'],))
                            self.db.commit()
                            continue
                        if payload.get('template') and self.cfg['platform'] == 'whatsapp_cloud':
                            ids, error = await adapter._post_messages({'messaging_product':'whatsapp','to':chat,'type':'template','template':payload['template']}, fail_log='[wabotia] template delivery failed', reject_log='[wabotia] HTTP %s: %s')
                            if error or not ids or not ids[0].get('id'):
                                raise RuntimeError('Template delivery not confirmed')
                            from gateway.platforms.base import SendResult
                            result = SendResult(success=True, message_id=ids[0]['id'])
                        else:
                            result = await send_native(adapter, self.cfg['platform'], chat, payload, target,
                                filename if target else None, media.headers.get('Content-Type') if target else None)
                        if not result.success or not result.message_id:
                            raise RuntimeError('Provider did not confirm delivery')
                        self.db.execute("UPDATE commands SET status='sent',external_id=? WHERE id=?", (str(result.message_id), command['id']))
                        if target:
                            target.unlink(missing_ok=True)
                    except ValueError:
                        self.db.execute("UPDATE commands SET status='failed',error='Conteúdo recusado antes do envio; confira os recursos do adaptador' WHERE id=?", (command['id'],))
                    except (Exception, asyncio.CancelledError):
                        self.db.execute("UPDATE commands SET status='unknown',error='Delivery not confirmed; reconcile in Wabotia' WHERE id=?", (command['id'],))
                    self.db.commit()
                    await self.receipt(self.db.execute('SELECT * FROM commands WHERE id=?', (command['id'],)).fetchone())
            except (httpx.HTTPError, OSError, KeyError):
                pass  # Durable journals and host spool survive network interruptions.
            await asyncio.sleep(3)
