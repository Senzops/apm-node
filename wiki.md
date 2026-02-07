## How to Use this (Production Ready)
This design resolves the "Express-only" limitation.

#### **Scenario A: Express / NestJS (Standard Node)**
```js
import { Senzor } from '@senzops/apm-node';

Senzor.init({ apiKey: "sz_apm_..." });
app.use(Senzor.requestHandler());
```

#### **Scenario B: Next.js (Server Actions / API Routes)**
Next.js doesn't use middleware the same way. Users can wrap handlers or use a manual track.

```javascript
// pages/api/user.ts
import { Senzor } from '@senzops/apm-node';

export default async function handler(req, res) {
  const start = performance.now();
  
  // ... logic ...
  
  // Track manually at end
  Senzor.track({
    method: req.method,
    route: '/api/user',
    path: req.url,
    status: res.statusCode,
    duration: performance.now() - start
  });
  
  // Critical for Vercel/Serverless: Wait for flush
  await Senzor.flush(); 
}
```

#### **Scenario C: Nitro / H3 (NuxtJS)**
```javascript
// server/middleware/senzor.ts
import { Senzor } from '@senzops/apm-node';

Senzor.init({ apiKey: "..." });

export default defineEventHandler(async (event) => {
  const start = performance.now();
  
  // Process request
  await callHandler(event);
  
  Senzor.track({
    method: event.method,
    route: event.path, // Nitro might need regex to normalize
    path: event.path,
    status: event.node.res.statusCode,
    duration: performance.now() - start
  });
});
```

### **Build Instructions**
Run this inside the `apm-node` directory:
```bash
npm install
npm run build
This will produce a lightweight `dist/` folder ready for publishing to NPM.
```

### **Using Wrappers**
**1. Express (Standard)**
```js
app.use(Senzor.requestHandler());
```

**2. Next.js App Router (`app/api/route.ts`)**
```javascript
import { Senzor } from '@senzops/apm-node';

export const GET = Senzor.wrapNextRoute(async (request) => {
  return Response.json({ success: true });
});
```
**3. Nuxt / Nitro (`server/api/test.ts`)**
```javascript
import { Senzor } from '@senzops/apm-node';

export default Senzor.wrapH3(defineEventHandler((event) => {
  return { hello: 'world' }
}));
```
**4. Fastify**
```javascript
import { Senzor } from '@senzops/apm-node';

fastify.register(Senzor.fastifyPlugin, { apiKey: '...' });
```
This approach provides **native robustness** for each framework. It captures errors (500s), 404s (Route not found), and correct timing without the user manually writing `track()` calls.