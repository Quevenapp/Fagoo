import { DurableObject } from 'cloudflare:workers';
import { createContainerBridge } from './bridge.mjs';
import { createExecutorDispatch } from './dispatch.mjs';
export class A1Custody extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.handle = createContainerBridge(ctx, env); }
  fetch(request) { return this.handle(request); }
}
export default { fetch: createExecutorDispatch({fetchImpl:(...args)=>globalThis.fetch(...args)}) };
