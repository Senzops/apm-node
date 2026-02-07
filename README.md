# **@senzops/apm-node**

The official Node.js middleware for **Senzor APM**.

Zero-overhead, asynchronous, and robust monitoring for your Express/Next.js APIs.

## **📦 Installation**
```sh
npm install @senzops/apm-node
```

## **🚀 Usage**

### **Express.js**

Add Senzor as the **first** middleware in your app to ensure accurate timing.
```js
const express = require('express');  
const senzor = require('@senzops/apm-node');

const app = express();

// 1\. Initialize  
senzor.init({  
 apiKey: "sz_apm_...", // Get this from your Senzor Dashboard  
 // Optional config  
 // debug: true,  
});

// 2\. Attach Request Handler  
app.use(senzor.requestHandler());

// ... your routes ...  
app.get('/users/:id', (req, res) => {  
 res.json({ id: req.params.id });  
});

app.listen(3000);
```

## **⚙️ Configuration**

| Option        | Type    | Description                                                   |
| :------------ | :------ | :------------------------------------------------------------ |
| apiKey        | string  | **Required.** Your Service API Key.                           |
| batchSize     | number  | Max requests to buffer before sending (Default: 100).         |
| flushInterval | number  | Max time (ms) to wait before sending buffer (Default: 10000). |
| debug         | boolean | Enable console logs for debugging connection issues.          |

## **🛡 Performance**

Senzor APM is designed to be **Production Safe**:

1. **Non-Blocking:** Data transmission happens asynchronously outside the request-response cycle.
2. **Fail-Open:** If Senzor ingestion is down, your API will continue to function normally without error.
3. **Lightweight:** Uses native Node.js timers and buffers. No heavy dependencies.
