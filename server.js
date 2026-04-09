const crypto = require("crypto");

const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";

if (IS_PROD && (!SESSION_SECRET || SESSION_SECRET === "change-me" || SESSION_SECRET.length < 24)) {
  throw new Error("SESSION_SECRET inseguro. Defina um valor forte (>= 24 caracteres) em produção.");
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || BASE_URL)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}

function originAllowed(req) {
  const origin = req.get("origin");
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

function csrfMiddleware(req, res, next) {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH" && req.method !== "DELETE") {
    return next();
  }

  if (!originAllowed(req)) {
    return res.status(403).json({ error: "Origin não permitido." });
  }

  if (req.path === "/auth") return next();

  const sessionToken = ensureCsrfToken(req);
  const headerToken = req.get("x-csrf-token");

  if (!headerToken || headerToken !== sessionToken) {
    return res.status(403).json({ error: "CSRF token inválido." });
  }

  return next();
}

app.use("/api", csrfMiddleware);app.get("/api/me", (req, res) => {
  const accounts = req.session?.user?.accounts || [];
  const logged = Boolean(req.session?.logged && accounts.length);
  ensureCsrfToken(req);
  res.json({ logged, accounts });
});

app.get("/api/csrf-token", (req, res) => {
  const token = ensureCsrfToken(req);
  res.json({ csrfToken: token });
});

app.get("/api/status", (req, res) => {
  const baseStatus = {
    ok: true,
    render: Boolean(process.env.RENDER),
    base_url: BASE_URL,
    port: PORT,
    has_session: Boolean(req.session?.logged),
    tokens_configured: IG_TOKENS.length,
    groq: Boolean(GROQ_API_KEY),
    gemini: Boolean(GEMINI_API_KEY)
  };

  if (!IS_PROD) {
    return res.json({
      ...baseStatus,
      session_id: req.sessionID || null,
      storage_root: STORAGE_ROOT,
      public_tmp_dir: PUBLIC_TMP_DIR,
      playwright_browsers_path: PLAYWRIGHT_BROWSERS_PATH || "(não definido)"
    });
  }

  return res.json(baseStatus);
});<script>
  let accounts = [];
  let csrfToken = "";

  function escapeText(value){
    return String(value ?? "");
  }

  async function ensureCsrfToken(){
    if (csrfToken) return csrfToken;
    const data = await fetch("/api/csrf-token", { credentials:"include" }).then(r => r.json());
    csrfToken = data.csrfToken || "";
    return csrfToken;
  }

  async function apiFetch(url, options = {}){
    const token = await ensureCsrfToken();
    const headers = { ...(options.headers || {}) };
    if (options.method && options.method !== "GET") {
      headers["x-csrf-token"] = token;
    }
    return fetch(url, { credentials:"include", ...options, headers });
  }

  async function init(){
    const me = await fetch("/api/me", { credentials:"include" }).then(r => r.json());
    if(!me.logged){
      window.location.href = "/";
      return;
    }
    accounts = me.accounts || [];
    await ensureCsrfToken();
    loadStatus();
  }

  async function loadStatus(){
    const data = await apiFetch("/api/status").then(r => r.json());
    document.getElementById("statusBox").textContent = JSON.stringify(data, null, 2);
  }

  async function runCompetitors(){
    const current = accounts[0];
    const competitors = document.getElementById("competitors").value
      .split("\n")
      .map(v => v.trim())
      .filter(Boolean);

    const payload = {
      igId: current?.id,
      niche: document.getElementById("niche").value,
      audience: "",
      competitors,
      location: document.getElementById("location").value,
      goal: "",
      tone: "",
      extra: ""
    };

    const res = await apiFetch("/api/competitors", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    const box = document.getElementById("result");
    box.textContent = "";

    (data.competitors_analysis || []).forEach((c) => {
      const card = document.createElement("div");
      card.className = "card";

      const h3 = document.createElement("h3");
      h3.textContent = escapeText(c.username || "");
      card.appendChild(h3);

      const fields = [
        ["Score", c.score || 0],
        ["Ameaça", c.threat_level || "-"],
        ["Confiança", c.data_confidence || "-"],
        ["Evidência", c.evidence_summary || "-"]
      ];

      fields.forEach(([label, val]) => {
        const div = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = `${label}: `;
        div.appendChild(strong);
        div.appendChild(document.createTextNode(escapeText(val)));
        card.appendChild(div);
      });

      const pre = document.createElement("pre");
      pre.textContent = escapeText(c.opportunity_against || "");
      card.appendChild(pre);

      box.appendChild(card);
    });
  }

  init();
</script>
