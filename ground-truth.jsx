import { useState, useRef, useEffect } from "react";

// ============================================================
// GROUND//TRUTH — provably grounded session assistant
// Upload a corpus → ask questions → every answer is either
// cited against the corpus or refused. Open mode adds web.
// Every exchange lands in an exportable audit log.
// ============================================================

const C = {
  bg: "#0C0B09",
  panel: "#14120E",
  panelHi: "#1A1712",
  line: "#2A251C",
  amber: "#E8A33D",
  amberDim: "#8A6526",
  green: "#4CCB8F",
  red: "#E05252",
  text: "#D8D2C4",
  dim: "#877F6C",
  faint: "#564F40",
};

const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "'Space Grotesk', system-ui, -apple-system, sans-serif";

const CLOSED_RULES = `You are the answer engine inside GROUND//TRUTH, a strictly grounded assistant operating in CLOSED-BOOK mode.

ABSOLUTE RULES:
1. You may ONLY use information contained in the session corpus provided below (attached PDF documents and/or text documents marked with === DOCUMENT: name === delimiters). Your general knowledge is OFF except for basic language understanding.
2. If the corpus does not contain enough information to answer, you MUST refuse by setting "grounded" to false. A partial answer from the corpus is fine, but never fill gaps from outside knowledge.
3. Every claim in your answer must be traceable to a citation.

RESPONSE FORMAT — respond with RAW JSON ONLY. No markdown fences, no preamble, no trailing text:
{
  "grounded": true | false,
  "answer": "your answer, or if not grounded, one or two sentences explaining what the corpus is missing",
  "citations": [
    { "doc": "exact document name", "evidence": "short pointer (under 25 words) to the supporting passage — section, phrase, or paraphrase" }
  ]
}

If grounded is false, citations must be an empty array.`;

const OPEN_RULES = `You are the answer engine inside GROUND//TRUTH, operating in OPEN mode. Prefer the session corpus (attached PDFs and/or === DOCUMENT === blocks) as your primary source, but you may also use web search and general knowledge to fill gaps.

In your answer, make the provenance of claims clear in plain prose (e.g. "per the uploaded spec..." vs "per current reporting..."). End your answer with a final line starting with "SOURCES:" listing corpus documents and/or web sources you relied on. Keep the answer focused and concise.`;

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

export default function GroundTruth() {
  const [docs, setDocs] = useState([]);
  const [mode, setMode] = useState("closed"); // 'closed' | 'open'
  const [feed, setFeed] = useState([]);
  const [audit, setAudit] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [showCorpus, setShowCorpus] = useState(true);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteName, setPasteName] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const fileRef = useRef(null);
  const feedRef = useRef(null);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [feed, busy]);

  // ---------- corpus handling ----------

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const f of files) {
      if (f.size > 8 * 1048576) {
        pushSystem(`"${f.name}" skipped — over the 8 MB session limit.`);
        continue;
      }
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      try {
        if (isPdf) {
          const data = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result.split(",")[1]);
            r.onerror = () => rej(new Error("read failed"));
            r.readAsDataURL(f);
          });
          setDocs((d) => [...d, { id: uid(), name: f.name, kind: "pdf", size: f.size, data }]);
        } else {
          const text = await f.text();
          setDocs((d) => [...d, { id: uid(), name: f.name, kind: "text", size: f.size, data: text }]);
        }
      } catch (e) {
        pushSystem(`Could not read "${f.name}".`);
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  function addPasted() {
    const name = pasteName.trim() || "pasted-note-" + (docs.length + 1) + ".txt";
    const body = pasteBody.trim();
    if (!body) return;
    setDocs((d) => [...d, { id: uid(), name, kind: "text", size: body.length, data: body }]);
    setPasteName("");
    setPasteBody("");
    setPasteOpen(false);
  }

  function removeDoc(id) {
    setDocs((d) => d.filter((x) => x.id !== id));
  }

  function pushSystem(text) {
    setFeed((f) => [...f, { id: uid(), role: "system", text, ts: Date.now() }]);
  }

  // ---------- API ----------

  function buildContent(question) {
    const content = [];
    for (const d of docs) {
      if (d.kind === "pdf") {
        content.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: d.data },
        });
      }
    }
    const textCorpus = docs
      .filter((d) => d.kind === "text")
      .map((d) => `=== DOCUMENT: ${d.name} ===\n${d.data}\n=== END DOCUMENT ===`)
      .join("\n\n");

    const rules = mode === "closed" ? CLOSED_RULES : OPEN_RULES;
    const parts = [rules];
    if (textCorpus) parts.push("SESSION CORPUS (text documents):\n\n" + textCorpus);
    if (docs.some((d) => d.kind === "pdf"))
      parts.push("Additional corpus documents are attached as PDFs above. Their filenames, in order: " +
        docs.filter((d) => d.kind === "pdf").map((d) => d.name).join(", "));
    parts.push("QUESTION: " + question);
    content.push({ type: "text", text: parts.join("\n\n----------------\n\n") });
    return content;
  }

  function historyMessages() {
    // prior turns as plain text so the model keeps conversational context
    const msgs = [];
    for (const item of feed) {
      if (item.role === "user") msgs.push({ role: "user", content: item.text });
      if (item.role === "answer")
        msgs.push({ role: "assistant", content: item.grounded === false ? "REFUSED: " + item.text : item.text });
    }
    return msgs.slice(-12);
  }

  async function ask() {
    const q = input.trim();
    if (!q || busy) return;
    if (mode === "closed" && docs.length === 0) {
      pushSystem("Closed-book mode needs a corpus. Upload at least one document, or switch to Open mode.");
      return;
    }
    setInput("");
    setBusy(true);
    const askedAt = Date.now();
    setFeed((f) => [...f, { id: uid(), role: "user", text: q, ts: askedAt }]);

    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [...historyMessages(), { role: "user", content: buildContent(q) }],
    };
    if (mode === "open") {
      body.tools = [{ type: "web_search_20250305", name: "web_search" }];
    }

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      const textOut = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      let entry;
      if (mode === "closed") {
        let parsed = null;
        try {
          parsed = JSON.parse(textOut.replace(/```json|```/g, "").trim());
        } catch (e) {
          parsed = null;
        }
        if (parsed && typeof parsed.grounded === "boolean") {
          entry = {
            id: uid(),
            role: "answer",
            mode: "closed",
            grounded: parsed.grounded,
            text: parsed.answer || "",
            citations: Array.isArray(parsed.citations) ? parsed.citations : [],
            ts: Date.now(),
          };
        } else {
          entry = {
            id: uid(),
            role: "answer",
            mode: "closed",
            grounded: null, // unverified — JSON contract broken
            text: textOut || "Empty response.",
            citations: [],
            ts: Date.now(),
          };
        }
      } else {
        entry = {
          id: uid(),
          role: "answer",
          mode: "open",
          grounded: "open",
          text: textOut || "Empty response.",
          citations: [],
          ts: Date.now(),
        };
      }

      setFeed((f) => [...f, entry]);
      setAudit((a) => [
        ...a,
        {
          ts: Date.now(),
          mode,
          query: q,
          corpus: docs.map((d) => d.name),
          result:
            entry.grounded === true
              ? "GROUNDED"
              : entry.grounded === false
              ? "REFUSED"
              : entry.grounded === "open"
              ? "OPEN"
              : "UNVERIFIED",
          citations: entry.citations.length,
        },
      ]);
    } catch (err) {
      pushSystem("Request failed: " + (err.message || "unknown error") + ". Try again.");
    } finally {
      setBusy(false);
    }
  }

  function exportAudit() {
    const payload = {
      product: "GROUND//TRUTH",
      exported_at: new Date().toISOString(),
      session_corpus: docs.map((d) => ({ name: d.name, kind: d.kind, bytes: d.size })),
      entries: audit,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ground-truth-audit-" + Date.now() + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- render helpers ----------

  function Stamp({ grounded }) {
    let label, color, glyph;
    if (grounded === true) { label = "GROUNDED"; color = C.green; glyph = "●"; }
    else if (grounded === false) { label = "NOT IN CORPUS"; color = C.red; glyph = "✕"; }
    else if (grounded === "open") { label = "OPEN MODE"; color = C.amber; glyph = "◍"; }
    else { label = "UNVERIFIED"; color = C.dim; glyph = "?"; }
    return (
      <span style={{
        fontFamily: MONO, fontSize: 10, letterSpacing: "0.14em", color,
        border: `1px solid ${color}55`, padding: "3px 8px", borderRadius: 3,
        background: color + "11", whiteSpace: "nowrap",
      }}>
        {glyph} {label}
      </span>
    );
  }

  const corpusBytes = docs.reduce((s, d) => s + d.size, 0);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text, fontFamily: SANS }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        ::selection { background: ${C.amber}44; }
        textarea, input { outline: none; }
        textarea:focus, input:focus, button:focus-visible { box-shadow: 0 0 0 1px ${C.amber}88; }
        .gt-scroll::-webkit-scrollbar { width: 8px; }
        .gt-scroll::-webkit-scrollbar-thumb { background: ${C.line}; border-radius: 4px; }
        .gt-fade { animation: gtfade .25s ease-out; }
        @keyframes gtfade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) { .gt-fade { animation: none; } }
        @media (max-width: 760px) {
          .gt-corpus { position: absolute; z-index: 20; height: 100%; box-shadow: 8px 0 24px #0009; }
          .gt-audit { position: absolute; right: 0; z-index: 20; height: 100%; box-shadow: -8px 0 24px #0009; }
        }
      `}</style>

      {/* ===== header ===== */}
      <header style={{
        display: "flex", alignItems: "center", gap: 14, padding: "10px 16px",
        borderBottom: `1px solid ${C.line}`, background: C.panel, flexWrap: "wrap",
      }}>
        <button onClick={() => setShowCorpus((v) => !v)} title="Toggle corpus panel" style={btnGhost}>☰</button>
        <div style={{ fontFamily: MONO, fontWeight: 500, fontSize: 15, letterSpacing: "0.05em" }}>
          <span style={{ color: C.amber }}>GROUND</span>
          <span style={{ color: C.faint }}>//</span>
          <span>TRUTH</span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim, letterSpacing: "0.1em" }}>
          PROVABLY GROUNDED SESSION ASSISTANT
        </div>

        <div style={{ flex: 1 }} />

        {/* mode toggle */}
        <div style={{ display: "flex", border: `1px solid ${C.line}`, borderRadius: 4, overflow: "hidden" }}>
          <button
            onClick={() => setMode("closed")}
            style={{ ...segBtn, background: mode === "closed" ? C.green + "22" : "transparent", color: mode === "closed" ? C.green : C.dim, borderRight: `1px solid ${C.line}` }}
          >
            ⬢ CLOSED-BOOK
          </button>
          <button
            onClick={() => setMode("open")}
            style={{ ...segBtn, background: mode === "open" ? C.amber + "22" : "transparent", color: mode === "open" ? C.amber : C.dim }}
          >
            ◍ OPEN + WEB
          </button>
        </div>

        <button onClick={() => setShowAudit((v) => !v)} style={{ ...btnGhost, color: showAudit ? C.amber : C.dim }}>
          AUDIT [{audit.length}]
        </button>
      </header>

      {/* ===== body ===== */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>

        {/* corpus panel */}
        {showCorpus && (
          <aside className="gt-corpus" style={{
            width: 264, flexShrink: 0, borderRight: `1px solid ${C.line}`, background: C.panel,
            display: "flex", flexDirection: "column",
          }}>
            <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.line}` }}>
              <div style={sectionLabel}>SESSION CORPUS</div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.faint, marginTop: 2 }}>
                {docs.length} doc{docs.length === 1 ? "" : "s"} · {fmtBytes(corpusBytes)}
              </div>
            </div>

            <div className="gt-scroll" style={{ flex: 1, overflowY: "auto", padding: 10 }}>
              {docs.length === 0 && (
                <div style={{ fontSize: 12, color: C.faint, lineHeight: 1.5, padding: 6 }}>
                  Empty corpus. In closed-book mode, the assistant can only speak from what you put here.
                </div>
              )}
              {docs.map((d) => (
                <div key={d.id} className="gt-fade" style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "8px 8px",
                  border: `1px solid ${C.line}`, borderRadius: 4, marginBottom: 6, background: C.panelHi,
                }}>
                  <span style={{ fontFamily: MONO, fontSize: 9, color: d.kind === "pdf" ? C.red : C.amber, border: `1px solid ${C.line}`, padding: "2px 4px", borderRadius: 2 }}>
                    {d.kind.toUpperCase()}
                  </span>
                  <span style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.name}>
                    {d.name}
                  </span>
                  <button onClick={() => removeDoc(d.id)} title="Remove from corpus" style={{ ...btnGhost, padding: "0 4px", color: C.faint }}>✕</button>
                </div>
              ))}
            </div>

            <div style={{ padding: 10, borderTop: `1px solid ${C.line}`, display: "flex", flexDirection: "column", gap: 6 }}>
              <input ref={fileRef} type="file" multiple accept=".pdf,.txt,.md,.csv,.json,.log" style={{ display: "none" }} onChange={(e) => addFiles(e.target.files)} />
              <button onClick={() => fileRef.current && fileRef.current.click()} style={btnPrimary}>
                + ADD DOCUMENTS
              </button>
              <button onClick={() => setPasteOpen((v) => !v)} style={btnGhostFull}>
                {pasteOpen ? "CANCEL PASTE" : "PASTE TEXT"}
              </button>
              {pasteOpen && (
                <div className="gt-fade" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <input
                    value={pasteName}
                    onChange={(e) => setPasteName(e.target.value)}
                    placeholder="document name"
                    style={inputStyle}
                  />
                  <textarea
                    value={pasteBody}
                    onChange={(e) => setPasteBody(e.target.value)}
                    placeholder="paste content…"
                    rows={5}
                    style={{ ...inputStyle, resize: "vertical", fontFamily: MONO, fontSize: 11 }}
                  />
                  <button onClick={addPasted} style={btnPrimary}>ADD TO CORPUS</button>
                </div>
              )}
            </div>
          </aside>
        )}

        {/* feed */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div ref={feedRef} className="gt-scroll" style={{ flex: 1, overflowY: "auto", padding: "20px 20px 8px" }}>
            {feed.length === 0 && (
              <div style={{ maxWidth: 520, margin: "48px auto", textAlign: "center" }}>
                <div style={{ fontFamily: MONO, fontSize: 11, color: C.faint, letterSpacing: "0.2em", marginBottom: 14 }}>
                  EVERY ANSWER CITED OR REFUSED
                </div>
                <div style={{ fontSize: 14, color: C.dim, lineHeight: 1.65 }}>
                  Load documents into the session corpus on the left, keep the mode on{" "}
                  <span style={{ color: C.green }}>closed-book</span>, and ask anything. Answers come stamped
                  with evidence from your documents — or a refusal when the corpus can't support one. Switch to{" "}
                  <span style={{ color: C.amber }}>open mode</span> to let it reach the web.
                </div>
              </div>
            )}

            {feed.map((item) => {
              if (item.role === "user")
                return (
                  <div key={item.id} className="gt-fade" style={{ margin: "18px 0 8px", display: "flex", gap: 10, alignItems: "baseline" }}>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: C.faint }}>{fmtTime(item.ts)} ▸</span>
                    <span style={{ fontSize: 14, fontWeight: 500 }}>{item.text}</span>
                  </div>
                );
              if (item.role === "system")
                return (
                  <div key={item.id} className="gt-fade" style={{ margin: "10px 0", fontFamily: MONO, fontSize: 11, color: C.amberDim }}>
                    ⚠ {item.text}
                  </div>
                );
              // answer card
              return (
                <div key={item.id} className="gt-fade" style={{
                  border: `1px solid ${C.line}`,
                  borderLeft: `3px solid ${item.grounded === true ? C.green : item.grounded === false ? C.red : C.amber}`,
                  borderRadius: 4, background: C.panel, padding: "12px 14px", margin: "6px 0 4px",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <Stamp grounded={item.grounded} />
                    <span style={{ fontFamily: MONO, fontSize: 10, color: C.faint }}>{fmtTime(item.ts)}</span>
                  </div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.65, whiteSpace: "pre-wrap", color: item.grounded === false ? C.dim : C.text }}>
                    {item.text}
                  </div>
                  {item.citations && item.citations.length > 0 && (
                    <div style={{ marginTop: 10, borderTop: `1px dashed ${C.line}`, paddingTop: 8 }}>
                      <div style={{ ...sectionLabel, marginBottom: 6 }}>EVIDENCE CHAIN</div>
                      {item.citations.map((c, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 5, alignItems: "baseline" }}>
                          <span style={{ fontFamily: MONO, fontSize: 10, color: C.green }}>[{i + 1}]</span>
                          <span style={{ fontFamily: MONO, fontSize: 11, color: C.amber, whiteSpace: "nowrap", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }} title={c.doc}>
                            {c.doc}
                          </span>
                          <span style={{ fontSize: 12, color: C.dim, lineHeight: 1.5 }}>{c.evidence}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {busy && (
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.amberDim, margin: "12px 0" }}>
                ▮ querying {mode === "closed" ? "corpus" : "corpus + web"}<Blink />
              </div>
            )}
          </div>

          {/* composer */}
          <div style={{ padding: 14, borderTop: `1px solid ${C.line}`, background: C.panel }}>
            <div style={{ display: "flex", gap: 8 }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
                }}
                placeholder={mode === "closed" ? "Ask the corpus…" : "Ask the corpus + the web…"}
                rows={2}
                style={{ ...inputStyle, flex: 1, resize: "none", fontSize: 13, lineHeight: 1.5 }}
              />
              <button onClick={ask} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.5 : 1, padding: "0 22px" }}>
                ASK
              </button>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.faint, marginTop: 6, letterSpacing: "0.08em" }}>
              MODE: {mode === "closed" ? "CLOSED-BOOK — corpus only, refusal on gaps" : "OPEN — corpus preferred, web permitted"} · CORPUS: {docs.length} DOC{docs.length === 1 ? "" : "S"}
            </div>
          </div>
        </main>

        {/* audit panel */}
        {showAudit && (
          <aside className="gt-audit" style={{
            width: 300, flexShrink: 0, borderLeft: `1px solid ${C.line}`, background: C.panel,
            display: "flex", flexDirection: "column",
          }}>
            <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center" }}>
              <div style={sectionLabel}>AUDIT LOG</div>
              <div style={{ flex: 1 }} />
              <button onClick={exportAudit} disabled={audit.length === 0} style={{ ...btnGhost, color: audit.length ? C.amber : C.faint }}>
                EXPORT JSON
              </button>
            </div>
            <div className="gt-scroll" style={{ flex: 1, overflowY: "auto", padding: 10 }}>
              {audit.length === 0 && (
                <div style={{ fontSize: 12, color: C.faint, padding: 6, lineHeight: 1.5 }}>
                  Every query lands here with its mode, corpus snapshot, and outcome.
                </div>
              )}
              {[...audit].reverse().map((a, i) => (
                <div key={i} style={{ borderBottom: `1px solid ${C.line}`, padding: "8px 4px", fontFamily: MONO, fontSize: 10.5, lineHeight: 1.7 }}>
                  <div style={{ color: C.faint }}>{fmtTime(a.ts)} · {a.mode.toUpperCase()}</div>
                  <div style={{ color: C.text, fontFamily: SANS, fontSize: 12, margin: "2px 0" }}>{a.query}</div>
                  <div>
                    <span style={{ color: a.result === "GROUNDED" ? C.green : a.result === "REFUSED" ? C.red : C.amber }}>
                      {a.result}
                    </span>
                    <span style={{ color: C.faint }}> · {a.citations} citation{a.citations === 1 ? "" : "s"} · {a.corpus.length} docs in scope</span>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function Blink() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn((v) => !v), 450);
    return () => clearInterval(t);
  }, []);
  return <span style={{ opacity: on ? 1 : 0 }}>_</span>;
}

const sectionLabel = {
  fontFamily: MONO, fontSize: 10, letterSpacing: "0.18em", color: C.dim,
};

const btnPrimary = {
  fontFamily: MONO, fontSize: 11, letterSpacing: "0.1em", padding: "9px 12px",
  background: C.amber + "1d", color: C.amber, border: `1px solid ${C.amber}55`,
  borderRadius: 4, cursor: "pointer",
};

const btnGhost = {
  fontFamily: MONO, fontSize: 11, letterSpacing: "0.08em", padding: "6px 8px",
  background: "transparent", color: C.dim, border: "none", borderRadius: 4, cursor: "pointer",
};

const btnGhostFull = {
  ...btnGhost, border: `1px solid ${C.line}`, padding: "8px 12px", textAlign: "center",
};

const inputStyle = {
  background: C.bg, border: `1px solid ${C.line}`, borderRadius: 4,
  color: C.text, padding: "8px 10px", fontFamily: SANS, fontSize: 12,
};
