import { useEffect, useState } from "react";
import { loadJson } from "./lib/codec";
import { fmtTime } from "./lib/format";
import { Overview } from "./overview";
import { Snapshots } from "./snapshots";
import type { Catalog, Scores } from "./types";
import { EmptyState } from "./widgets";

const BASE = import.meta.env.BASE_URL;

export function App() {
  const [tab, setTab] = useState<"scores" | "ledger">("scores");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [scores, setScores] = useState<Scores | null>(null);
  const [version, setVersion] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    Promise.all([loadJson(`${BASE}data/catalog.json`), loadJson(`${BASE}data/scores.json`)])
      .then(([catalogDoc, scoresDoc]) => {
        if (cancel) return;
        const next = catalogDoc as Catalog;
        const scored = scoresDoc as Scores;
        setCatalog(next);
        setScores(scored);
        const latest = [...next.versions].sort((a, b) => (b.last ?? "").localeCompare(a.last ?? ""))[0];
        setVersion(latest?.model_version ?? next.versions[0]?.model_version ?? "");
      })
      .catch((reason: unknown) => {
        if (!cancel) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancel = true;
    };
  }, []);

  const versionMeta = catalog?.versions.find((item) => item.model_version === version);
  const byVariable = version && scores ? scores.by_version[version] : null;
  const chain = catalog?.provenance.ledger?.chain_head;

  return (
    <>
      <a className="skip" href="#content">Skip to content</a>
      <header className="top">
        <div>
          <p className="eyebrow">ČHMÚ · 40 stations</p>
          <h1>MeteoVerdict Verify</h1>
          <p className="lede">Mean absolute error against the observations, on the same station-hours.</p>
        </div>
        <nav>
          <button type="button" aria-pressed={tab === "scores"} onClick={() => setTab("scores")}>
            Scores
          </button>
          <button type="button" aria-pressed={tab === "ledger"} onClick={() => setTab("ledger")}>
            Ledger
          </button>
        </nav>
      </header>
      <main id="content">
        {!catalog && !error && <p className="banner">Loading the derived scores…</p>}
        {error && (
          <EmptyState message={`The browser could not load data/catalog.json or data/scores.json (${error}).`} />
        )}
        {catalog && scores && versionMeta && (
          <>
            <section className="status">
              <p>{versionMeta.text}</p>
              <p className="meta">
                {versionMeta.snapshots} snapshots
                {versionMeta.first && versionMeta.last ? `, ${fmtTime(versionMeta.first)} – ${fmtTime(versionMeta.last)}` : ""}.
                Model version {versionMeta.model_version}. Generated {fmtTime(catalog.generated)}.
                {catalog.withdrawn_skipped.length > 0
                  ? ` ${catalog.withdrawn_skipped.length} withdrawn releases are excluded.`
                  : ""}
              </p>
              {catalog.versions.length > 1 && (
                <label className="version">
                  Model version
                  <select value={version} onChange={(event) => setVersion(event.target.value)}>
                    {catalog.versions.map((item) => (
                      <option key={item.model_version} value={item.model_version}>
                        {item.model_version} ({item.days} days)
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </section>
            {tab === "scores" ? (
              <Overview key={version} catalog={catalog} byVariable={byVariable} modelVersion={version} />
            ) : (
              <Snapshots catalog={catalog} />
            )}
          </>
        )}
        {catalog && scores && !versionMeta && catalog.snapshots.length === 0 && (
          <EmptyState message="The catalog is published and lists no scorable snapshots yet." />
        )}
      </main>
      <footer>
        <p>
          <a href="https://github.com/JerryWoof/MeteoVerdict-Verify">Repository</a>
          {" · "}
          <a href="https://github.com/JerryWoof/MeteoVerdict-Verify/blob/main/preregistration/v1.md">Preregistration</a>
          {" · "}
          <a href="https://github.com/JerryWoof/MeteoVerdict-Verify/tree/main/ledger">Release files</a>
          {" · "}
          <a href="https://meteoverdict.cz">meteoverdict.cz</a> is a different site. This page is only the verification log.
        </p>
        {chain && <p className="hash">Chain head {chain}</p>}
      </footer>
    </>
  );
}
