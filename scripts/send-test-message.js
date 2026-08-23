const { getConfig, loadEnvFile, send } = require('../src/messenger');

async function main() {
  const [chatUrl] = process.argv.slice(2);
  if (!chatUrl) {
    throw new Error(
      'Cach dung: npm run messenger:test -- https://www.messenger.com/t/ID_CHAT',
    );
  }

  loadEnvFile();
  await send(
    {
      ...getConfig(),
      chatUrl,
      message: 'test',
    },
    true,
  );
}

main().catch((error) => {
  console.error(`Loi: ${error.message}`);
  process.exitCode = 1;
});
