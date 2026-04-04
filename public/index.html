<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Instagram Planner Agency</title>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0c0a1a;
      --card:#17142d;
      --border:rgba(255,255,255,.08);
      --text:#fff;
      --muted:rgba(255,255,255,.6);
      --brand:#ff6b35;
      --brand2:#ffd166;
      --ok:#62d394;
      --danger:#ff7b7b;
    }
    body{
      font-family:'DM Sans',sans-serif;
      background:linear-gradient(180deg,#0c0a1a,#121028);
      color:var(--text);
      min-height:100vh;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:24px;
    }
    .wrap{
      width:100%;
      max-width:980px;
      display:grid;
      grid-template-columns:1.1fr .9fr;
      gap:24px;
      align-items:stretch;
    }
    .hero,.card{
      background:rgba(255,255,255,.04);
      border:1px solid var(--border);
      border-radius:24px;
      padding:32px;
      backdrop-filter:blur(10px);
    }
    .hero h1{
      font-family:'Syne',sans-serif;
      font-size:clamp(2rem,4vw,3.3rem);
      line-height:1.05;
      margin-bottom:18px;
    }
    .hero h1 span{
      background:linear-gradient(90deg,var(--brand),var(--brand2));
      -webkit-background-clip:text;
      -webkit-text-fill-color:transparent;
      background-clip:text;
    }
    .hero p{
      color:var(--muted);
      font-size:1rem;
      line-height:1.7;
      margin-bottom:24px;
    }
    .pill{
      display:inline-block;
      padding:6px 12px;
      border-radius:999px;
      background:rgba(255,107,53,.14);
      color:#ffb38a;
      border:1px solid rgba(255,107,53,.25);
      font-size:12px;
      margin-bottom:16px;
    }
    .list{
      display:grid;
      gap:12px;
      margin-top:18px;
    }
    .list div{
      padding:14px 16px;
      border-radius:14px;
      background:rgba(255,255,255,.03);
      border:1px solid rgba(255,255,255,.06);
      color:rgba(255,255,255,.82);
      font-size:14px;
      line-height:1.6;
    }
    .card h2{
      font-family:'Syne',sans-serif;
      font-size:1.2rem;
      margin-bottom:18px;
    }
    .btn{
      width:100%;
      border:none;
      border-radius:16px;
      padding:16px 20px;
      background:linear-gradient(135deg,var(--brand),#f7931e);
      color:#fff;
      font-family:'Syne',sans-serif;
      font-size:1rem;
      cursor:pointer;
      margin-top:10px;
    }
    .btn:disabled{opacity:.6;cursor:not-allowed}
    .btn.secondary{
      background:rgba(255,255,255,.06);
      border:1px solid var(--border);
    }
    .status{
      margin-top:14px;
      min-height:22px;
      color:var(--muted);
      font-size:13px;
      line-height:1.6;
    }
    .status.ok{color:var(--ok)}
    .status.error{color:var(--danger)}
    .mini{
      color:var(--muted);
      font-size:13px;
      line-height:1.6;
      margin-top:12px;
    }
    .stack{display:grid;gap:10px}
    @media (max-width: 860px){
      .wrap{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div class="pill">Ferramenta interna da agência</div>
      <h1>Seu <span>painel Ferrari</span> para Instagram</h1>
      <p>
        Conecte contas, leia dados reais, gere análise estratégica, concorrência por IA,
        planejamento mensal, stories, roteiros de reels e exporte tudo em PDF.
      </p>

      <div class="list">
        <div>📊 Dashboard com leitura estratégica do perfil</div>
        <div>🧠 Diagnóstico por IA com oportunidades e ações</div>
        <div>🥊 Análise de concorrência por IA</div>
        <div>📅 Planejamento mensal com posts, stories e reels</div>
        <div>📕 Exportação em PDF para uso interno</div>
      </div>
    </section>

    <section class="card">
      <h2>Conectar ferramenta</h2>
      <p class="mini">
        O sistema usa os tokens configurados em <strong>IG_TOKENS</strong> e inicia sua sessão
        com as contas disponíveis.
      </p>

      <div class="stack">
        <button class="btn" id="connectBtn">Entrar no painel</button>
        <button class="btn secondary" id="statusBtn">Testar servidor</button>
      </div>

      <div class="status" id="status"></div>

      <p class="mini">
        Dica: se quiser adicionar uma conta extra manualmente, depois do login você também pode
        testar outro token diretamente no painel.
      </p>
    </section>
  </div>

  <script>
    const btn = document.getElementById("connectBtn");
    const statusBtn = document.getElementById("statusBtn");
    const status = document.getElementById("status");

    function setStatus(message, type = "") {
      status.textContent = message;
      status.className = "status" + (type ? ` ${type}` : "");
    }

    async function safeJson(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }

    async function testServer() {
      setStatus("Testando servidor...");
      try {
        const res = await fetch("/health", {
          method: "GET",
          credentials: "include",
          cache: "no-store"
        });

        if (!res.ok) throw new Error("Servidor indisponível.");

        const text = await res.text();
        if (text !== "OK") throw new Error("Healthcheck inesperado.");

        setStatus("Servidor online e respondendo normalmente.", "ok");
      } catch (error) {
        setStatus("Não consegui validar o servidor agora.", "error");
      }
    }

    async function connect() {
      btn.disabled = true;
      setStatus("Conectando contas...");

      try {
        const res = await fetch("/api/auth", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({})
        });

        const data = await safeJson(res);

        if (!res.ok || !data?.success) {
          setStatus(data?.error || "Erro ao iniciar sessão.", "error");
          btn.disabled = false;
          return;
        }

        setStatus("Sessão criada. Validando acesso...", "ok");

        const meRes = await fetch("/api/me", {
          method: "GET",
          credentials: "include",
          cache: "no-store"
        });

        const me = await safeJson(meRes);

        if (!meRes.ok || !me?.logged) {
          setStatus("A sessão não foi mantida. Tente novamente.", "error");
          btn.disabled = false;
          return;
        }

        setStatus("Tudo certo. Entrando no painel...", "ok");
        window.location.href = "/app";
      } catch (error) {
        setStatus("Erro de conexão com o servidor.", "error");
        btn.disabled = false;
      }
    }

    btn.addEventListener("click", connect);
    statusBtn.addEventListener("click", testServer);

    testServer();
  </script>
</body>
</html>
