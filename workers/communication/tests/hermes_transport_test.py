import asyncio, importlib.util, json, tempfile, unittest, sys, types
from unittest.mock import patch
from pathlib import Path
spec=importlib.util.spec_from_file_location('wabotia_transport',Path(__file__).resolve().parents[1]/'connectors/hermes/__init__.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Response:
    def __init__(self,value):self.value=value
    def json(self):return self.value
class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();home=Path(self.tmp.name)
        (home/'wabotia-connector.json').write_text(json.dumps({'url':'https://example.com','connection_id':'test','token':'fake','platform':'whatsapp'}))
        self.worker=module.Transport(home);self.calls=[]
        async def request(route,**kwargs):self.calls.append((route,kwargs));return Response({'id':'media-id'})
        self.worker.request=request
    async def asyncTearDown(self):self.worker.close();self.worker.db.close();self.tmp.cleanup()
    async def test_group_is_consumed_without_fallthrough(self):
        result=await self.worker.receive({'platform':'whatsapp','chat_type':'group','chat':'test@g.us','user':'participant','message_id':'g1','text':'Olá'},None)
        self.assertTrue(result);self.assertEqual(self.calls[0][1]['body']['chat_type'],'group')
        self.assertEqual(self.calls[0][1]['body']['content']['participant'],'participant')
    async def test_preserves_provider_id_on_replay(self):
        msg={'platform':'whatsapp','chat_type':'dm','chat':'5511@s.whatsapp.net','user':'5511','message_id':'provider-id','text':'Teste'}
        await self.worker.receive(msg,None);await self.worker.receive(msg,None)
        self.assertEqual([c[1]['body']['message_id'] for c in self.calls],['provider-id','provider-id'])
    async def test_caches_uploaded_media_on_replay(self):
        file=Path(self.tmp.name)/'image.txt';file.write_text('Anexo')
        msg={'platform':'whatsapp','chat_type':'dm','chat':'5511','user':'5511','message_id':'id','text':'','media':[{'path':str(file)}]}
        await self.worker.receive(msg,None);await self.worker.receive(msg,None)
        self.assertEqual([c[0] for c in self.calls],['/media-content','/events','/events'])
        self.assertEqual(self.calls[-1][1]['body']['attachments'],['media-id'])
class NativeContentTests(unittest.IsolatedAsyncioTestCase):
    async def test_cloud_uses_required_adapter_arguments_and_native_voice(self):
        class Adapter:
            async def send_voice(self, *args, **kwargs): pass
            async def _upload_media(self, path, kind, mime_type=None):
                self.upload=(path,kind,mime_type);return 'asset',None
            async def _post_messages(self, body, *, fail_log, reject_log, reject_args=()):
                self.body=body;return [{'id':'provider-id'}],None
        adapter=Adapter()
        with patch.dict(sys.modules, {'gateway':types.ModuleType('gateway'),'gateway.platforms':types.ModuleType('gateway.platforms'),'gateway.platforms.base':types.SimpleNamespace(SendResult=lambda **kw:types.SimpleNamespace(**kw))}):
            result=await module.send_native(adapter,'whatsapp_cloud','5511999990000',{'content':{'type':'voice','reply_external_id':'original'}},Path('/tmp/voice.ogg'),'voice.ogg','audio/ogg')
        self.assertTrue(result.success);self.assertEqual(result.message_id,'provider-id')
        self.assertEqual(adapter.body['audio'],{'id':'asset','voice':True})
        self.assertEqual(adapter.body['context'],{'message_id':'original'})
        self.assertEqual(adapter.upload[1],'audio')
    async def test_adapter_base_fallback_is_not_advertised_as_native_media(self):
        class Base:
            async def send_image_file(self,*args,**kwargs): pass
        class TextOnly(Base): pass
        self.assertNotIn('image',module.features(TextOnly(),'whatsapp'))
if __name__=='__main__':unittest.main()
