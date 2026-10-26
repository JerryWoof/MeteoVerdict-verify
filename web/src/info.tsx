import type { Catalog } from "./types";

export function Info({ catalog }: { catalog: Catalog }) {
  const minPairs = catalog.thresholds.min_pairs;
  const keep = Math.round(catalog.thresholds.keep_fraction * 100);
  return (
    <section className="view info">
      <p>
        The forecasts are the public releases as they were issued. A score uses only hours where a ČHMÚ station recorded an observation. The code that builds these numbers is in the repository.
      </p>

      <h2>What is compared</h2>
      <p>
        Each release is taken at its snapshot time. A model contributes the run that was available then. A later run is not written back, and a withdrawn release is left out. MeteoVerdict and MeteoVerdict AI are the values stored in that release. They are scored with the same rule as every other series.
      </p>

      <h2>Truth</h2>
      <p>
        Truth is the ČHMÚ observation at that station and hour. Every series is compared with that same observation. A day stays provisional until a checked file replaces it, and the scores can change when that happens.
      </p>

      <h2>Common-pair MAE</h2>
      <p>
        MAE is the mean of |forecast − observation|. A lower value is a closer forecast on that set of hours. The table is sorted by that MAE, lowest first. No series is held at the top.
      </p>
      <p>
        A station-hour is counted only when every series in the table has a forecast and the observation exists. A missing hour is left missing. Nothing is filled from an older release.
      </p>
      <p>
        The shared set starts from the hours where MeteoVerdict AI and an observation both exist. Other series are added from the fullest coverage to the sparsest, and only while the shared hours stay at least {keep}% of that set and at least {minPairs} pairs. A series that would shrink the set further is listed as excluded. It does not receive a second MAE on a different set of hours.
      </p>

      <h2>Lead windows</h2>
      <p>
        D+k is valid time minus snapshot time in [24k, 24k+24) hours, for k = 0…5. D+0 is the first 24 hours. Every series uses that same window. Full is the unweighted mean of the rounded lead scores that have pairs. A lead with no pairs is left out of the mean. Full is that definition, not a choice of which leads to include.
      </p>
      <p>
        The preregistration’s main bands are D+1 to D+3. D+4 and D+5 are secondary.
      </p>

      <h2>Scores and Ledger</h2>
      <p>
        Scores is the network figure for the whole recorded period: one MAE per series on the common station-hours. Open a row, or a bar, for how that number was calculated and where the error is smaller or larger.
      </p>
      <p>
        Ledger opens one release at one station, so the forecast can be read against the observations on those hours. It is not a second network score. One station and a few hours can sit in a different order from the network mean.
      </p>

      <h2>Limits</h2>
      <p>
        The line under the title is the data-volume label. Fewer than 30 live snapshot days is not enough data, and this page does not say that a model works. Scores use the full-precision errors. The Ledger chart is drawn from values rounded to a tenth, so a one-station figure can differ in the second decimal.
      </p>
    </section>
  );
}
