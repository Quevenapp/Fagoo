"""Native content supported by the installed Hermes adapter; no second consumer."""
from pathlib import Path


def features(adapter, platform):
    methods = {'image': 'send_image_file', 'video': 'send_video', 'voice': 'send_voice',
               'document': 'send_document', 'edit': 'edit_message', 'location': 'send_location'}
    # A base-class fallback that sends a file path as text is not native support.
    result = [kind for kind, method in methods.items() if method in type(adapter).__dict__]
    if 'voice' in result:
        result.append('audio')
    if platform == 'whatsapp_cloud' and hasattr(adapter, '_post_messages'):
        result += ['reply', 'reaction', 'contacts', 'location', 'sticker', 'groups']
    elif platform == 'whatsapp':
        result += ['groups']
    return sorted(set(result))


async def send_native(adapter, platform, chat, payload, target=None, filename=None, mime=None):
    from gateway.platforms.base import SendResult
    content = payload.get('content') or {}
    kind = content.get('type') or 'text'
    if kind != 'text' and kind not in features(adapter, platform):
        raise ValueError('Recurso não oferecido pelo adaptador Hermes instalado: ' + kind)
    if platform == 'whatsapp_cloud':
        body = {'messaging_product': 'whatsapp', 'to': chat}
        if payload.get('chat_type') == 'group':
            body['recipient_type'] = 'group'
        if content.get('reply_external_id'):
            body['context'] = {'message_id': content['reply_external_id']}
        if target:
            native_kind = 'audio' if kind == 'voice' else kind
            media_id, error = await adapter._upload_media(str(target), native_kind, mime)
            if error or not media_id:
                raise ValueError('O adaptador recusou o arquivo antes do envio.')
            media = {'id': media_id}
            if native_kind in ('image', 'video', 'document') and payload.get('text'):
                media['caption'] = payload['text']
            if native_kind == 'document':
                media['filename'] = filename or Path(target).name
            if kind == 'voice':
                media['voice'] = True
            body.update(type=native_kind, **{native_kind: media})
        elif kind == 'reaction':
            body.update(type='reaction', reaction={'message_id': content['target_external_id'], 'emoji': content['emoji']})
        elif kind == 'contacts':
            body.update(type='contacts', contacts=[{'name': {'formatted_name': c['name'], 'first_name': c['name']}, 'phones': [{'phone': c['phone']}]} for c in content['contacts']])
        elif kind == 'location':
            body.update(type='location', location=content['location'])
        else:
            body.update(type='text', text={'body': payload.get('text', '')})
        ids, error = await adapter._post_messages(body, fail_log='[wabotia] delivery failed',
                                                reject_log='[wabotia] HTTP %s: %s')
        return SendResult(success=bool(ids) and not error, message_id=ids[0].get('id') if ids else None, error=error)
    if target:
        method = {'image': 'send_image_file', 'video': 'send_video', 'audio': 'send_voice', 'voice': 'send_voice', 'document': 'send_document'}[kind]
        kwargs = {'caption': payload.get('text') or None, 'reply_to': content.get('reply_external_id')}
        if kind == 'document':
            kwargs['file_name'] = filename
        return await getattr(adapter, method)(chat, str(target), **kwargs)
    if kind == 'edit':
        return await adapter.edit_message(chat, content['target_external_id'], content['text'])
    if kind == 'location':
        loc = content['location']
        return await adapter.send_location(chat, loc['latitude'], loc['longitude'], name=loc.get('name'), address=loc.get('address'))
    return await adapter.send(chat, payload.get('text', ''), reply_to=content.get('reply_external_id'))
