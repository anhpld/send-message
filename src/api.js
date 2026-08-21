const http = require('node:http');
const { getConfig, loadEnvFile, send, validateChatUrl } = require('./messenger');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_LENGTH = 10_000;

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        const error = new Error('Request body vượt quá 64 KB.');
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (tooLarge) return;
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch {
        const error = new Error('Request body phải là JSON hợp lệ.');
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function getRequestPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Request body phải là một JSON object.');
    error.statusCode = 400;
    throw error;
  }

  const chatUrl = body.MESSENGER_CHAT_URL ?? body.chatUrl;
  const message = body.MESSAGE_TEXT ?? body.message;

  try {
    validateChatUrl(chatUrl);
  } catch (cause) {
    const error = new Error(cause.message);
    error.statusCode = 400;
    throw error;
  }

  if (typeof message !== 'string' || !message.trim()) {
    const error = new Error('MESSAGE_TEXT phải là chuỗi không rỗng.');
    error.statusCode = 400;
    throw error;
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    const error = new Error(`MESSAGE_TEXT không được vượt quá ${MAX_MESSAGE_LENGTH} ký tự.`);
    error.statusCode = 400;
    throw error;
  }

  return { chatUrl, message };
}

function isAuthorized(request, apiKey) {
  if (!apiKey) return true;
  const authorization = request.headers.authorization;
  const bearerToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  return request.headers['x-api-key'] === apiKey || bearerToken === apiKey;
}

function createQueue() {
  let tail = Promise.resolve();
  let pending = 0;

  return {
    add(task) {
      pending += 1;
      const result = tail.then(task, task);
      tail = result.catch(() => {}).finally(() => {
        pending -= 1;
      });
      return result;
    },
    size() {
      return pending;
    },
  };
}

function createServer(options = {}) {
  const messengerConfig = options.messengerConfig || getConfig();
  const apiKey = options.apiKey ?? process.env.API_KEY;
  const sendMessage = options.sendMessage || send;
  const queue = createQueue();
  let requestSequence = 0;

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      json(response, 200, { ok: true, queuedRequests: queue.size() });
      return;
    }

    if (request.method !== 'POST' || requestUrl.pathname !== '/api/messages') {
      json(response, 404, { ok: false, error: 'Not found' });
      return;
    }

    if (!isAuthorized(request, apiKey)) {
      json(response, 401, { ok: false, error: 'API key không hợp lệ.' });
      return;
    }

    const requestId = ++requestSequence;
    try {
      const payload = getRequestPayload(await readJson(request));
      await queue.add(() =>
        sendMessage(
          {
            ...messengerConfig,
            chatUrl: payload.chatUrl,
            message: payload.message,
          },
          true,
        ),
      );

      json(response, 200, { ok: true, requestId, message: 'Đã gửi tin nhắn.' });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      console.error(`[request ${requestId}] ${error.message}`);
      json(response, statusCode, {
        ok: false,
        requestId,
        error: statusCode === 500 ? 'Không thể gửi tin nhắn.' : error.message,
      });
    }
  });
}

function isLoopback(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

function main() {
  loadEnvFile();
  const host = process.env.API_HOST || '127.0.0.1';
  const port = Number(process.env.API_PORT || 3000);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('API_PORT phải là số nguyên từ 0 đến 65535.');
  }
  if (!isLoopback(host) && !process.env.API_KEY) {
    throw new Error('Phải đặt API_KEY khi API_HOST không phải địa chỉ loopback.');
  }

  const server = createServer();
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`Messenger API đang chạy tại http://${host}:${address.port}`);
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Lỗi: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createServer, getRequestPayload };
