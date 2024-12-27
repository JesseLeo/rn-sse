const XMLReadyStateMap = [
  "UNSENT",
  "OPENED",
  "HEADERS_RECEIVED",
  "LOADING",
  "DONE",
];

class EventSource {
  ERROR = -1;
  CONNECTING = 0;
  OPEN = 1;
  CLOSED = 2;

  CRLF = "\r\n";
  LF = "\n";
  CR = "\r";

  constructor(url, options = {}) {
    this.lastEventId = null;
    this.status = this.CONNECTING;

    this.eventHandlers = {
      open: [],
      message: [],
      content_block_start: [],
      error: [],
      close: [],
    };

    this.method = options.method || "GET";
    this.timeout = options.timeout ?? 0;
    this.timeoutBeforeConnection = options.timeoutBeforeConnection ?? 500;
    this.withCredentials = options.withCredentials || false;
    this.headers = options.headers || {};
    this.body = options.body || undefined;
    this.debug = options.debug || false;
    this.interval = options.pollingInterval ?? 5000;
    this.lineEndingCharacter = options.lineEndingCharacter || null;

    this._xhr = null;
    this._pollTimer = null;
    this._lastIndexProcessed = 0;

    if (
      !url ||
      (typeof url !== "string" && typeof url.toString !== "function")
    ) {
      throw new SyntaxError("[EventSource] Invalid URL argument.");
    }

    if (typeof url.toString === "function") {
      this.url = url.toString();
    } else {
      this.url = url;
    }

    this._pollAgain(this.timeoutBeforeConnection, true);
  }

  _pollAgain(time, allowZero) {
    if (time > 0 || allowZero) {
      this._logDebug(`[EventSource] Will open new connection in ${time} ms.`);
      this._pollTimer = setTimeout(() => {
        this.open();
      }, time);
    }
  }

  open() {
    try {
      this.status = this.CONNECTING;
      this._lastIndexProcessed = 0;
      this._xhr = new XMLHttpRequest();
      this._xhr.open(this.method, this.url, true);

      if (this.withCredentials) {
        this._xhr.withCredentials = true;
      }

      this._xhr.setRequestHeader("Accept", "*/*");
      this._xhr.setRequestHeader("Cache-Control", "no-cache");
      this._xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");

      if (this.headers) {
        for (const [key, value] of Object.entries(this.headers)) {
          this._xhr.setRequestHeader(key, value);
        }
      }

      if (this.lastEventId !== null) {
        this._xhr.setRequestHeader("Last-Event-ID", this.lastEventId);
      }

      this._xhr.timeout = this.timeout;

      this._xhr.onreadystatechange = () => {
        if (this.status === this.CLOSED) {
          return;
        }

        const xhr = this._xhr;
        this._logDebug(
          `[EventSource][onreadystatechange] ReadyState: ${
            XMLReadyStateMap[xhr.readyState] || "Unknown"
          }(${xhr.readyState}), status: ${xhr.status}`
        );

        if (
          ![XMLHttpRequest.DONE, XMLHttpRequest.LOADING].includes(
            xhr.readyState
          )
        ) {
          return;
        }
        console.log(xhr.getResponseHeader("Content-Type"));

        if (xhr.status >= 200 && xhr.status < 400) {
          if (this.status === this.CONNECTING) {
            this.status = this.OPEN;
            if (xhr.getResponseHeader("Content-Type") !== "application/json") {
              this.dispatch("open", { type: "open" });
            } else {
              this._handleError("error", this._xhr.responseText);
              console.log(this._xhr);
            }
            this._logDebug(
              "[EventSource][onreadystatechange][OPEN] Connection opened."
            );
          }

          if (xhr.getResponseHeader("Content-Type") !== "application/json") {
            this._handleEvent(xhr.responseText || "");
          }

          if (xhr.readyState === XMLHttpRequest.DONE) {
            this._logDebug(
              "[EventSource][onreadystatechange][DONE] Operation done."
            );
            this._pollAgain(this.interval, false);
          }
        } else if (xhr.status !== 0) {
          this._handleError(
            "error",
            xhr.responseText,
            xhr.status,
            xhr.readyState
          );
        }
      };

      this._xhr.onerror = () => {
        if (this.status === this.CLOSED) {
          return;
        }
        this._handleError(
          "error",
          this._xhr.responseText,
          this._xhr.status,
          this._xhr.readyState
        );
      };

      if (this.body) {
        this._xhr.send(this.body);
      } else {
        this._xhr.send();
      }

      if (this.timeout > 0) {
        setTimeout(() => {
          if (this._xhr.readyState === XMLHttpRequest.LOADING) {
            this.dispatch("error", { type: "timeout" });
            this.close();
          }
        }, this.timeout);
      }
    } catch (e) {
      this._handleError("exception", e.message, null, null, e);
    }
  }

  _handleError(type, message, xhrStatus = null, xhrState = null, error = null) {
    this.status = this.ERROR;
    this.dispatch("error", {
      type,
      message,
      xhrStatus,
      xhrState,
      error,
    });
  }

  _logDebug(...msg) {
    if (this.debug) {
      console.debug(...msg);
    }
  }

  _handleEvent(response) {
    if (this.lineEndingCharacter === null) {
      const detectedNewlineChar = this._detectNewlineChar(response);
      if (detectedNewlineChar !== null) {
        this._logDebug(
          `[EventSource] Detected lineEndingCharacter: ${JSON.stringify(
            detectedNewlineChar
          ).slice(1, -1)}`
        );
        this.lineEndingCharacter = detectedNewlineChar;
      } else {
        console.warn("[EventSource] Unable to identify line ending character");
        return;
      }
    }

    const indexOfDoubleNewline = this._getLastDoubleNewlineIndex(response);
    if (indexOfDoubleNewline <= this._lastIndexProcessed) {
      return;
    }

    const newData = response.substring(
      this._lastIndexProcessed,
      indexOfDoubleNewline
    );
    const messages = this._parseSSEMessages(newData);
    this._lastIndexProcessed = indexOfDoubleNewline;

    for (const message of messages) {
      this._processMessage(message);
    }
  }

  _parseSSEMessages(data) {
    const messages = [];
    let currentMessage = {
      event: undefined,
      data: [],
      id: null,
    };

    const lines = data.split(this.lineEndingCharacter);

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine === "") {
        if (currentMessage.data.length > 0 || currentMessage.event) {
          messages.push({ ...currentMessage });
          currentMessage = { event: undefined, data: [], id: null };
        }
        continue;
      }

      if (trimmedLine.startsWith("event:")) {
        currentMessage.event = trimmedLine.slice(6).trim();
      } else if (trimmedLine.startsWith("data:")) {
        currentMessage.data.push(trimmedLine.slice(5).trim());
      } else if (trimmedLine.startsWith("id:")) {
        currentMessage.id = trimmedLine.slice(3).trim();
      }
    }

    return messages;
  }

  _processMessage(message) {
    if (
      !message.event ||
      ["ping", "message_delta", "content_block_stop"].includes(message.event)
    ) {
      return;
    }

    let currentText = "";

    for (const dataItem of message.data) {
      try {
        const jsonData = JSON.parse(dataItem);

        switch (message.event) {
          case "content_block_delta":
            if (jsonData.delta?.text) {
              currentText += jsonData.delta.text;
            }
            break;

          case "message_start":
            currentText = "";
            break;

          case "content_block_start":
            currentText = "";
            break;

          case "message_stop":
            this.dispatch("close", {
              type: "close",
              data: currentText,
            });
            currentText = "";
            break;
        }
      } catch (e) {
        console.warn("JSON parse error:", e, dataItem);
      }
    }

    if (currentText && message.event === "content_block_delta") {
      console.log("content_block_delta", currentText);
      this.dispatch("message", {
        type: "message",
        data: currentText,
        url: this.url,
        lastEventId: message.id || this.lastEventId,
      });
    }
  }

  _detectNewlineChar(response) {
    const supportedLineEndings = [this.CRLF, this.LF, this.CR];
    for (const char of supportedLineEndings) {
      if (response.includes(char)) {
        return char;
      }
    }
    return null;
  }

  _getLastDoubleNewlineIndex(response) {
    const doubleLineEndingCharacter =
      this.lineEndingCharacter + this.lineEndingCharacter;
    const lastIndex = response.lastIndexOf(doubleLineEndingCharacter);
    if (lastIndex === -1) {
      return -1;
    }

    return lastIndex + doubleLineEndingCharacter.length;
  }

  addEventListener(type, listener) {
    if (this.eventHandlers[type] === undefined) {
      this.eventHandlers[type] = [];
    }

    this.eventHandlers[type].push(listener);
  }

  removeEventListener(type, listener) {
    if (this.eventHandlers[type] !== undefined) {
      this.eventHandlers[type] = this.eventHandlers[type].filter(
        (handler) => handler !== listener
      );
    }
  }

  removeAllEventListeners(type) {
    const availableTypes = Object.keys(this.eventHandlers);

    if (type === undefined) {
      for (const eventType of availableTypes) {
        this.eventHandlers[eventType] = [];
      }
    } else {
      if (!availableTypes.includes(type)) {
        throw Error(
          `[EventSource] '${type}' type is not supported event type.`
        );
      }

      this.eventHandlers[type] = [];
    }
  }

  dispatch(type, data) {
    const availableTypes = Object.keys(this.eventHandlers);

    if (!availableTypes.includes(type)) {
      return;
    }

    for (const handler of Object.values(this.eventHandlers[type])) {
      handler(data);
    }
  }

  close() {
    if (this.status !== this.CLOSED) {
      this.status = this.CLOSED;
      this.dispatch("close", { type: "close" });
    }

    clearTimeout(this._pollTimer);
    if (this._xhr) {
      this._xhr.abort();
    }
  }
}

export default EventSource;
