import { registerHooks } from 'node:module';

const fixture = new URL('./private-screening-fixture.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../frontend/guard-demo/adapters/nearai/screen.mjs'
      && context.parentURL?.endsWith('/src/native-private-screening.js')) {
      return { url: fixture, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});
