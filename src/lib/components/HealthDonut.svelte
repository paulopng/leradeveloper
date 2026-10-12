<script lang="ts">
  /**
   * HealthDonut — a dependency-free SVG donut chart with a legend. Built for the
   * Dashboard's install-health split (current / outdated / modified / foreign /
   * removed), but generic: pass any `{ label, value, color }[]`.
   *
   * Arcs are drawn with stroke-dasharray on overlaid circles (the classic
   * no-library technique); the group is rotated -90° so the first segment starts
   * at twelve o'clock. A zero-total donut renders just the track ring.
   */
  type Segment = { label: string; value: number; color: string; onClick?: () => void };

  let {
    segments,
    centerLabel,
    centerSub,
    size = 132,
  }: {
    segments: Segment[];
    centerLabel?: string;
    centerSub?: string;
    size?: number;
  } = $props();

  const STROKE = 16;
  const R = 50; // viewBox is 0 0 120 120
  const C = 2 * Math.PI * R;

  const total = $derived(segments.reduce((s, x) => s + x.value, 0));

  // Precompute each visible segment's dash length + accumulated offset.
  const arcs = $derived.by(() => {
    const out: { color: string; len: number; offset: number; onClick?: () => void; label: string }[] = [];
    if (total <= 0) return out;
    let acc = 0;
    for (const s of segments) {
      if (s.value <= 0) continue;
      const len = (s.value / total) * C;
      out.push({ color: s.color, len, offset: -acc, onClick: s.onClick, label: s.label });
      acc += len;
    }
    return out;
  });
</script>

<div class="hd">
  <div class="hd-chart" style="width:{size}px;height:{size}px">
    <svg viewBox="0 0 120 120" role="img" aria-label={`${total} total`}>
      <g transform="rotate(-90 60 60)">
        <circle cx="60" cy="60" r={R} fill="none" style="stroke: var(--color-surface-sunken)" stroke-width={STROKE} />
        {#each arcs as a (a.label)}
          <circle
            cx="60" cy="60" r={R} fill="none"
            style={`stroke:${a.color}`} stroke-width={STROKE}
            stroke-dasharray={`${a.len} ${C - a.len}`}
            stroke-dashoffset={a.offset}
            class:clickable={!!a.onClick}
            role={a.onClick ? "button" : undefined}
            aria-label={a.onClick ? a.label : undefined}
            onclick={a.onClick}
          />
        {/each}
      </g>
    </svg>
    {#if centerLabel}
      <div class="hd-center">
        <span class="hd-num">{centerLabel}</span>
        {#if centerSub}<span class="hd-sub">{centerSub}</span>{/if}
      </div>
    {/if}
  </div>

  <ul class="hd-legend">
    {#each segments as s (s.label)}
      <li>
        <button class="hd-row" class:clickable={!!s.onClick} disabled={!s.onClick} onclick={s.onClick}>
          <span class="hd-swatch" style="background:{s.color}"></span>
          <span class="hd-label">{s.label}</span>
          <span class="hd-val">{s.value}</span>
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .hd { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
  .hd-chart { position: relative; flex: none; }
  .hd-chart svg { width: 100%; height: 100%; display: block; }
  .hd-chart circle.clickable { cursor: pointer; }
  .hd-chart circle.clickable:hover { opacity: 0.85; }
  .hd-center {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; pointer-events: none;
  }
  .hd-num { font-size: 26px; font-weight: var(--fw-bold); color: var(--color-text-primary); line-height: 1; }
  .hd-sub { font-size: 10px; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.04em; }

  .hd-legend { flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 1px; }
  .hd-row {
    display: flex; align-items: center; gap: var(--space-2); width: 100%;
    padding: 4px var(--space-2); border-radius: var(--radius-sm);
    background: transparent; text-align: left;
  }
  .hd-row.clickable { cursor: pointer; }
  .hd-row.clickable:hover { background: var(--color-surface-sunken); }
  .hd-swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
  .hd-label { flex: 1; font-size: var(--text-body-sm); color: var(--color-text-secondary); }
  .hd-val { font-size: var(--text-body-sm); font-weight: var(--fw-semibold); color: var(--color-text-primary); font-variant-numeric: tabular-nums; }
</style>
