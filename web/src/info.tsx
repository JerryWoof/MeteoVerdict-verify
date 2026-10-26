import type { Catalog } from "./types";

const REPO = "https://github.com/JerryWoof/MeteoVerdict-Verify";

export function Info({ catalog }: { catalog: Catalog }) {
  const minPairs = catalog.thresholds.min_pairs;
  const keep = Math.round(catalog.thresholds.keep_fraction * 100);
  return (
    <section className="view info">
      <h2>Open source</h2>
      <p>
        The scoring code and the files it reads are public. The same releases can be checked again by anyone.{" "}
        <a href={REPO}>JerryWoof/MeteoVerdict-Verify</a>.
      </p>

      <h2>Immutable Git releases</h2>
      <p>
        Each forecast is a GitHub release, published when it was issued. The release carries a cryptographic attestation.
        The ledger row stores the tar sha256 and the chain hash of the rows before it. A later forecast is not written
        back into an earlier release. That is the fairness argument: the number was public before the observations used
        to score it.
      </p>
      <p>
        <a href={`${REPO}/releases`}>Releases</a>
        {" · "}
        <a href={`${REPO}/tree/main/ledger`}>Ledger files</a>
        {" · "}
        <a href={`${REPO}/blob/main/preregistration/v1.md`}>Preregistration</a>
      </p>
      <p>
        How a forecast gets into a release is the Git history of that repository: one snapshot, one tag, one tar. This
        site starts from those tags.
      </p>
      <p>
        A release taken down on purpose is listed in <code>ledger/withdrawn.json</code>. It is left out of the scores.
        Its ledger row and hash stay in the chain, so the earlier history is still dated. Those rows are not rewritten
        to hide the withdrawal.
      </p>

      <h2>What this site does with a release</h2>
      <p>
        The build checks the tar sha256 against the ledger row, then writes the static files the browser loads: the
        catalog, the scores, and one chart file per release. It does not edit the forecast values in the release. A
        hash mismatch stops the build.
      </p>

      <h2>How a score is computed</h2>
      <p>
        Truth is the ČHMÚ observation at that station and hour. MAE is the mean of |forecast − observation|. The table
        is that order, lowest first. Nothing is held at the top.
      </p>
      <p>
        A station-hour counts only when every series in the table has a forecast and the observation exists. A missing
        hour stays missing. Nothing is filled from an older release.
      </p>
      <p>
        The shared set starts from the hours where MeteoVerdict AI and an observation both exist. Other series join
        from the fullest coverage to the sparsest, and only while the shared hours stay at least {keep}% of that set
        and at least {minPairs} pairs. A series that would shrink the set further is listed as excluded. It does not
        get a second MAE on a different set of hours.
      </p>
      <p>
        D+k is valid time minus snapshot time in [24k, 24k+24) hours, for k = 0…5. Every series uses that same window.
        Full is the unweighted mean of the rounded lead scores that have pairs. A lead with no pairs is left out of
        the mean. The preregistration’s main bands are D+1 to D+3. D+4 and D+5 are secondary.
      </p>

      <h2>Scores and Ledger</h2>
      <p>
        Scores is the network figure for the recorded period: one MAE per series on the common station-hours. Open a
        row, or a bar, for the station-hours behind that number.
      </p>
      <p>
        Ledger opens one release at one station, the oldest release in the list on load, so a forecast can be read
        against the observations on those hours. It is not a second network score. One station and a few hours can
        sit in a different order from the network mean.
      </p>
      <p>
        The line under the title is the data-volume label. Fewer than 30 live snapshot days is not enough data, and
        this page does not say that a model works. Scores use the full-precision errors. The Ledger chart is drawn
        from values rounded to a tenth.
      </p>
    </section>
  );
}
