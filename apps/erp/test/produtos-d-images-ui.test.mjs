import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { imageFileType, readStoredImages, storedSize } from '../src/lib/product-images-model.ts';

// Imagens armazenadas do produto (migração 193) na interface: lista com prévias (data: URL), envio por "anexar arquivos" e por
// arrastar e soltar com "Conferir resultado", mudar a ordem e remover. Dados sintéticos.
const product = '98000000-0000-4000-8000-000000000001', a = '98000000-0000-4000-8000-0000000000a1', b = '98000000-0000-4000-8000-0000000000b1', c = '98000000-0000-4000-8000-0000000000c1';
const actor = '98000000-0000-4000-8000-0000000000ff', stamp = '2026-10-20T12:00:00+00:00';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=', 'base64'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const image = (id, position, extra = {}) => ({ id, product_id: product, filename: `anexo-${id.slice(-2)}.png`, mime_type: 'image/png', size_bytes: png.length, sha256: sha(png), status: 'ready', position,
  created_at: stamp, finished_at: stamp, deleted: false, owner_name: 'Admin', ...extra });
const page = items => ({ product_id: product, items, pending: [], stored_bytes: String(png.length * items.length), limit: 20, data_mode: 'erp_native' });
const file = name => Object.assign(new Blob([png], { type: 'image/png' }), { name });

test('model: page shape, file types and sizes', () => {
  assert.deepEqual(readStoredImages(page([image(a, 1), image(b, 2)]), product).items.map(item => item.id), [a, b]);
  assert.throws(() => readStoredImages(page([image(a, 2)]), product), 'positions follow the order');
  assert.throws(() => readStoredImages({ ...page([]), product_id: b }, product));
  assert.equal(imageFileType({ name: 'Foto.JPEG', size: 10, type: '' }), 'image/jpeg');
  assert.throws(() => imageFileType({ name: 'foto.gif', size: 10, type: 'image/gif' }), /PNG ou JPEG/);
  assert.throws(() => imageFileType({ name: 'foto.png', size: 2 * 1024 * 1024 + 1, type: 'image/png' }), /até 2 MB/);
  assert.deepEqual([storedSize('512'), storedSize(2048), storedSize(3 * 1024 * 1024)], ['512 B', '2,0 KB', '3,0 MB']);
});

function server() {
  const calls = []; let items = [image(a, 1), image(b, 2)], postAttempts = 0;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async attachments(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body instanceof Blob ? 'blob' : options.body && structuredClone(options.body) });
      if (path === `/v1/anexos-cadastros/produtos/${product}` && !options.method) return page(items);
      if (path.endsWith('/download')) return new Blob([png]);
      if (path === `/v1/anexos-cadastros/produtos/${product}` && options.method === 'POST') return { image: image(c, null, { status: 'reserved', filename: 'anexo-nova.png' }), replayed: false, data_mode: 'erp_native' };
      if (path === `/v1/anexos-cadastros/produtos/${product}/${c}/upload`) { postAttempts++; if (postAttempts === 1) throw new AccessError(503); items = [...items, image(c, 3)]; return { image: image(c, 3), replayed: false, data_mode: 'erp_native' }; }
      if (path === `/v1/anexos-cadastros/produtos/${product}/ordem`) { items = options.body.ids.map((id, n) => image(id, n + 1)); return { ...page(items), replayed: false }; }
      if (path.endsWith('/exclusao')) { const id = path.split('/').at(-2); items = items.filter(item => item.id !== id).map((item, n) => ({ ...item, position: n + 1 })); return { image: image(id, null, { deleted: true }), replayed: false, data_mode: 'erp_native' }; }
      throw new AccessError(404);
    },
  };
  return { calls, controller };
}

test('stored images: previews, upload with "Conferir resultado", order and removal, each with its own command', async () => {
  const service = server();
  const view = await mountComponent('ProductStoredImages.tsx', { controller: service.controller, productId: product, writable: true }, {});
  try {
    await view.flush(); await view.flush();
    assert.match(view.text(), /2 de 20 imagens/);
    const previews = view.nodes().filter(node => node.type === 'img');
    assert.equal(previews.length, 2);
    assert.match(previews[0].props.src, /^data:image\/png;base64,/);
    assert.match(view.text(), /Arraste e solte as imagens aqui ou/);
    view.input(`product-images-${product}`).props.onChange({ target: { files: [file('nova.png')] } }); await view.flush(); await view.flush();
    assert.match(view.text(), /O envio de nova\.png precisa ser confirmado\./);
    const reserve = service.calls.find(call => call.method === 'POST' && call.path === `/v1/anexos-cadastros/produtos/${product}`);
    assert.deepEqual([reserve.body.filename, reserve.body.mime_type, reserve.body.size_bytes, reserve.body.sha256], ['nova.png', 'image/png', png.length, sha(png)]);
    await view.click('Conferir resultado'); await view.flush();
    assert.equal(service.calls.filter(call => call.method === 'POST' && call.path === `/v1/anexos-cadastros/produtos/${product}`).length, 1, 'the reservation is not repeated');
    assert.equal(service.calls.filter(call => call.path.endsWith(`/${c}/upload`)).length, 2, 'the same upload is sent again');
    assert.match(view.text(), /Imagens enviadas\./); assert.match(view.text(), /3 de 20 imagens/);
    assert.deepEqual([a, b, c].map(id => service.calls.filter(call => call.path.endsWith(`/${id}/download`)).length), [1, 1, 1], 'a preview already shown is not downloaded again');
    assert.ok(view.nodes().some(node => node.props?.to === '/empresa-configuracoes?secao=armazenamento'), 'the company storage usage screen');
    view.find(node => node.props?.['aria-label'] === 'Mover a imagem armazenada 2 para a esquerda').props.onClick(); await view.flush();
    assert.deepEqual(service.calls.filter(call => call.path.endsWith('/ordem')).at(-1).body.ids, [b, a, c]);
    view.find(node => node.props?.['aria-label'] === 'Remover a imagem armazenada 1').props.onClick(); await view.flush(); await view.flush();
    assert.ok(service.calls.some(call => call.path === `/v1/anexos-cadastros/produtos/${product}/${b}/exclusao`), 'the first image (b) is removed');
    assert.match(view.text(), /2 de 20 imagens/);
    // Drag and drop goes through the same checks: a GIF is refused before any request.
    const before = service.calls.length;
    view.find(node => node.type === 'div' && /product-image-drop/.test(node.props.className ?? '')).props.onDrop({ preventDefault() {}, dataTransfer: { files: [Object.assign(new Blob(['x']), { name: 'a.gif' })] } }); await view.flush();
    assert.match(view.text(), /a\.gif: use uma imagem PNG ou JPEG\./);
    assert.equal(service.calls.length, before);
  } finally { view.unmount(); }
});

test('stored images: a new product asks to save first; read-only profiles see the images without the controls', async () => {
  const fresh = await mountComponent('ProductStoredImages.tsx', { controller: server().controller, productId: null, writable: true }, {});
  try { assert.match(fresh.text(), /Salve o produto para enviar imagens armazenadas no FAGOO\./); } finally { fresh.unmount(); }
  const view = await mountComponent('ProductStoredImages.tsx', { controller: server().controller, productId: product, writable: false }, {});
  try {
    await view.flush();
    assert.equal(view.nodes().some(node => node.props?.id === `product-images-${product}`), false);
    assert.equal(view.nodes().some(node => /^Remover a imagem/.test(node.props?.['aria-label'] ?? '')), false);
    assert.match(view.text(), /2 de 20 imagens/);
  } finally { view.unmount(); }
});

test('controller: the product image routes of the attachment proxy, with their methods', async () => {
  const { createAccessController, AccessError: RealAccessError } = await import('../src/lib/real-access.ts');
  const uid = 'a0000000-0000-4000-8000-000000000001', session = { access_token: 'synthetic-token', user: { id: uid } };
  const auth = { getSession: async () => ({ data: { session }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({ error: null }) };
  const calls = [];
  const controller = createAccessController(auth, 'https://api.example.test', async (url, options) => {
    if (url.endsWith('/me')) return Response.json({ user_id: uid, role: 'admin', resources: [], data_mode: 'staging_readonly' }); calls.push({ url, options });
    return url.endsWith('/download') ? new Response('x', { headers: { 'Content-Type': 'application/octet-stream' } }) : Response.json({ data_mode: 'erp_native' });
  });
  const stop = controller.start(); await new Promise(resolve => setTimeout(resolve, 0));
  try {
    const base = `/v1/anexos-cadastros/produtos/${product}`;
    await controller.attachments(`${base}/ordem`, { method: 'POST', body: { command_id: a, ids: [a] } });
    await controller.attachments(`${base}/${a}/upload`, { method: 'PUT', body: new Blob([png]), contentType: 'image/png' });
    assert.ok(await controller.attachments(`${base}/${a}/download`, { download: true }) instanceof Blob);
    assert.deepEqual(calls.map(call => [call.url.replace('https://api.example.test', ''), call.options.method]), [[`${base}/ordem`, 'POST'], [`${base}/${a}/upload`, 'PUT'], [`${base}/${a}/download`, 'GET']]);
    for (const [path, options] of [[`${base}/ordem`, { method: 'GET' }], [`${base}/x/upload`, { method: 'PUT', body: new Blob(['x']), contentType: 'image/png' }], [`/v1/anexos-cadastros/produtos/${product}/ordem/x`, {}]])
      await assert.rejects(() => controller.attachments(path, options), error => error instanceof RealAccessError && error.status === 400, path);
  } finally { stop(); }
});
