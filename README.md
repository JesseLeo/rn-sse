### Yarn

```bash
yarn add rn-sse
```

### NPM

```bash
npm install --save rn-sse
```

## Usage

We are using Server-Sent Events as a convenient way of establishing and handling Mercure connections. It helps us keep data always up-to-date, synchronize data between devices, and improve real-time workflow. Here you have some usage examples:

### Import

```js
import EventSource from "rn-sse";
```

### Connection and listeners

```js
import EventSource from "rn-sse";

const es = new EventSource("https://your-sse-server.com/.well-known/mercure");

es.addEventListener("open", (event) => {
  console.log("Open SSE connection.");
});

es.addEventListener("message", (event) => {
  console.log("New message event:", event.data);
});

es.addEventListener("error", (event) => {
  if (event.type === "error") {
    console.error("Connection error:", event.message);
  } else if (event.type === "exception") {
    console.error("Error:", event.message, event.error);
  }
});

es.addEventListener("close", (event) => {
  console.log("Close SSE connection.");
});
```
