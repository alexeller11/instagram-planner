require("dotenv").config();
const { fetchInstagramAccount } = require("./ai/instagram");

async function test() {
  const token = process.env.TEST_IG_TOKEN;
  if (!token) {
    console.error("❌ Erro: TEST_IG_TOKEN não definido no ambiente.");
    process.exit(1);
  }

  console.log("🚀 Testando fetchInstagramAccount com token...");
  const account = await fetchInstagramAccount(token);
  
  if (account) {
    console.log("✅ Sucesso! Conta encontrada:");
    console.log(JSON.stringify(account, null, 2));
  } else {
    console.log("❌ Falha: Nenhuma conta do Instagram Business encontrada para este token.");
    console.log("Dicas: Verifique se o token tem as permissões corretas e se a conta do Instagram está vinculada a uma página do Facebook como 'Business Account'.");
  }
}

test();
