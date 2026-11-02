import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStrict,serialize} from '../src/xml.mjs';

const encodings=['UTF-8','UTf-8','UtF-8','Utf-8','uTF-8','uTf-8','utF-8','utf-8'];
const declaration=value=>`<?xml version="1.0" encoding="${value}"?>`;

test('only the UTF-8 encoding value is case-insensitive; original declaration is not rewritten',()=>{
 for(const encoding of encodings){
  const input=declaration(encoding)+'<root>ação</root>',doc=parseStrict(input);
  assert.equal(doc.firstChild.target,'xml');
  assert.equal(doc.firstChild.data,`version="1.0" encoding="${encoding}"`);
  assert.equal(doc.documentElement.textContent,'ação');
  assert.equal(serialize(doc.documentElement),'<root>ação</root>');
  assert.equal(input,declaration(encoding)+'<root>ação</root>');
 }
 for(const prefix of['','<?xml version="1.0"?>'])assert.equal(parseStrict(prefix+'<root/>').documentElement.localName,'root');
});

test('alternative encodings and broadened XML declaration syntax remain outside the strict profile',()=>{
 const bad=[...['UTF8','UTF-16','ISO-8859-1','utf-8 ',' utf-8','utf‐8'].map(declaration),
  '<?XML version="1.0" encoding="utf-8"?>','<?xml Version="1.0" encoding="utf-8"?>',
  '<?xml version="1.0" Encoding="utf-8"?>','<?xml version="1.1" encoding="utf-8"?>',
  "<?xml version='1.0' encoding='utf-8'?>",'<?xml encoding="utf-8" version="1.0"?>',
  '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',' '+declaration('utf-8')];
 for(const prefix of bad)assert.throws(()=>parseStrict(prefix+'<root/>'),e=>e.code==='XML_PROCESSING_INSTRUCTION_UNSUPPORTED');
});

test('lowercase declaration does not relax DTD/entities, additional PI, duplicate declarations or encoding bounds',()=>{
 const prefix=declaration('utf-8');
 for(const xml of[prefix+'<?evil x?><root/>',prefix+prefix+'<root/>','<root>'+prefix+'</root>',prefix+'<root><?xml version="1.0"?></root>'])
  assert.throws(()=>parseStrict(xml),e=>e.code==='XML_PROCESSING_INSTRUCTION_UNSUPPORTED');
 for(const xml of[prefix+'<!DOCTYPE root SYSTEM "file:///never-read"><root/>',prefix+'<!DOCTYPE root [<!ENTITY x "boom">]><root>&x;</root>',prefix+'<!--comment--><root/>',prefix+'<root><![CDATA[x]]></root>'])
  assert.throws(()=>parseStrict(xml),e=>e.code==='XML_DECLARATION_UNSUPPORTED');
 for(const xml of['\uFEFF'+prefix+'<root/>',prefix+'<root>\u0000</root>',prefix+'<root>\ud800</root>'])
  assert.throws(()=>parseStrict(xml),e=>e.code==='XML_ENCODING_INVALID');
 assert.throws(()=>parseStrict(prefix+'<root>&unknown;</root>'),e=>e.code==='XML_MALFORMED');
});
