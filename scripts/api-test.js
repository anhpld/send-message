const { createServer, getRequestPayload } = require('../src/api');

async function main() {
  const payload = getRequestPayload({
    MESSENGER_CHAT_URL: 'https://www.messenger.com/t/123456789',
    MESSAGE_TEXT: 'test',
  });
  if (payload.message !== 'test') throw new Error('Payload validation failed.');

  const sentMessages = [];
  const server = createServer({
    apiKey: 'test-key',
    sendMessage: async (config, confirmSend) => {
      sentMessages.push({ config, confirmSend });
    },
    messengerConfig: {
      baseUrl: 'https://www.messenger.com/',
      storageStatePath: '.playwright/test-state.json',
      diagnosticsDir: '.playwright/test-diagnostics',
      timeoutMs: 1_000,
      headless: true,
    },
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address();
    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    const health = await healthResponse.json();
    if (healthResponse.status !== 200 || health.ok !== true) {
      throw new Error('Health endpoint failed.');
    }

    const unauthorizedResponse = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (unauthorizedResponse.status !== 401) throw new Error('API auth test failed.');

    const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-key' },
      body: JSON.stringify({ MESSENGER_CHAT_URL: 'https://example.com/t/1', MESSAGE_TEXT: 'test' }),
    });
    if (invalidResponse.status !== 400) throw new Error('Payload rejection test failed.');

    const sendResponse = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({
        MESSENGER_CHAT_URL: 'https://www.messenger.com/t/123456789',
        MESSAGE_TEXT: 'API test',
      }),
    });
    const sendResult = await sendResponse.json();
    if (sendResponse.status !== 200 || !sendResult.ok) throw new Error('Send endpoint failed.');
    if (sentMessages.length !== 1 || sentMessages[0].config.message !== 'API test') {
      throw new Error('Send payload was not forwarded.');
    }
    if (sentMessages[0].confirmSend !== true) throw new Error('Send confirmation flag missing.');

    console.log('Messenger API test: OK');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
