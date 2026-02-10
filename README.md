# **@senzops/apm-node**

The official Node.js SDK for **Senzor APM**.

A lightweight, zero-dependency, and universal APM client for modern JavaScript runtimes.

## **✨ Features**

* **Universal Support:** Works in Node.js (18+), Edge, and Serverless environments.  
* **Auto-Instrumentation:** Automatically captures HTTP calls (Axios/Fetch), MongoDB queries, and Postgres queries.  
* **Framework Agnostic:** Built-in wrappers for Express, Next.js, Fastify, and Nuxt (Nitro).  
* **Distributed Tracing:** Captures full waterfall execution graphs (Spans).  
* **Zero Overhead:** Uses async_hooks and non-blocking transports.

## **📦 Installation**
```sh
npm install @senzops/apm-node  
# or  
yarn add @senzops/apm-node
```
## **🚀 Quick Start (Express.js)**

Add Senzor as the **first middleware** in your app.
```js
const express = require('express');  
const Senzor = require('@senzops/apm-node');

const app = express();

// 1. Initialize  
Senzor.init({  
  apiKey: "sz_apm_...", // Get from Senzor Dashboard  
});

// 2. Attach Request Handler  
app.use(Senzor.requestHandler());

// ... your routes ...  
app.get('/', async (req, res) => {  
  // Database calls here are automatically traced\!  
  res.json({ hello: 'world' });  
});

app.listen(3000);
```
## **📚 Documentation**

For detailed usage with **Next.js**, **NestJS**, **Fastify**, or **Manual Instrumentation**, please read our [**Detailed Wiki**](./wiki.md).