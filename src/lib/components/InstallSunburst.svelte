<script lang="ts">
  /**
   * InstallSunburst — a two-ring (nested) donut. The INNER ring is the top-level
   * groups; the OUTER ring is each group's children, aligned radially under their
   * parent (children must sum to the parent's value). Dependency-free SVG, same
   * stroke-dasharray technique as HealthDonut, rotated -90° so segment 0 starts
   * at twelve o'clock. Built for the dashboard's Global-vs-Projects install split
   * (outer = per-tool for Global, per-project for Projects).
   */
  type Segment = { label: string; value: number; color: string; onClick?: () => void };
  type Group = Segment & { children: Segment[] };

  let {
    groups,
    centerLabel,
    centerSub,
    size = 132,
  }: { groups: Group[]; centerLabel?: string; centerSub?: string; size?: number } = $props();

  const total = $derived(groups.reduce((s, g) => s + g.value, 0));
  const children = $derived(groups.flatMap((g) => g.children));

  // Outer ring matches the single-ring donuts (HealthDonut / CoverageDonuts):
  // same viewBox (120), radius (50) and stroke (16), so every donut on the
  // dashboard shares one diameter + ring weight. The inner ring nests inside.
  const R_OUT = 50;
  const W_OUT = 16;
  const R_IN = 29;
  const W_IN = 12;

  function arcs(segs: Segment[], r: number) {
    const C = 2 * Math.PI * r;
    const out: { seg: Segment; len: number; offset: number; circ: number }[] = [];
    if (total <= 0) return out;
    let acc = 0;
    for (const s of segs) {
      if (s.value <= 0) continue;
      const len = (s.value / total) * C;
      out.push({ seg: s, len, offset: -acc, circ: C });
      acc += len;
    }
    return out;
  }
  const innerArcs = $derived(arcs(groups, R_IN));
  const outerArcs = $derived(arcs(children, R_OUT));

  let hovered = $state<string | null>(null);
</script>

<div class="sb">
  <div class="sb-chart" style="width:{size}px;height:{size}px">
    <svg viewBox="0 0 120 120" role="img" aria-label={`${total} total`}>
      <g transform="rotate(-90 60 60)">
        <circle cx="60" cy="60" r={R_OUT} fill="none" style="stroke:var(--color-surface-sunken)" stroke-width={W_OUT} />
        <circle cx="60" cy="60" r={R_IN} fill="none" style="stroke:var(--color-surface-sunken)" stroke-width={W_IN} />
        {#each outerArcs as a (a.seg.label)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <circle
            cx="60" cy="60" r={R_OUT} fill="none"
            style={`stroke:${a.seg.color}`} stroke-width={W_OUT}
            stroke-dasharray={`${a.len} ${a.circ - a.len}`} stroke-dashoffset={a.offset}
            class="seg" class:dim={hovered !== null && hovered !== a.seg.label} class:clickable={!!a.seg.onClick}
            role={a.seg.onClick ? "button" : "img"}
            aria-label={`${a.seg.label}: ${a.seg.value}`}
            onmouseenter={() => (hovered = a.seg.label)}
            onmouseleave={() => (hovered = null)}
            onclick={a.seg.onClick}
          ><title>{a.seg.label}: {a.seg.value}</title></circle>
        {/each}
        {#each innerArcs as a (a.seg.label)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <circle
            cx="60" cy="60" r={R_IN} fill="none"
            style={`stroke:${a.seg.color}`} stroke-width={W_IN}
            stroke-dasharray={`${a.len} ${a.circ - a.len}`} stroke-dashoffset={a.offset}
            class="seg" class:clickable={!!a.seg.onClick}
            role={a.seg.onClick ? "button" : "img"}
            aria-label={`${a.seg.label}: ${a.seg.value}`}
            onclick={a.seg.onClick}
          ><title>{a.seg.label}: {a.seg.value}</title></circle>
        {/each}
      </g>
    </svg>
    {#if centerLabel}
      <div class="sb-center">
        <span class="sb-num">{centerLabel}</span>
        {#if centerSub}<span class="sb-sub">{centerSub}</span>{/if}
      </div>
    {/if}
  </div>

  <ul class="sb-legend">
    {#each groups as g (g.label)}
      <li class="sb-grp">
        <button class="sb-row group" class:clickable={!!g.onClick} disabled={!g.onClick} onclick={g.onClick}>
          <span class="sb-swatch" style="background:{g.color}"></span>
          <span class="sb-label">{g.label}</span>
          <span class="sb-val">{g.value}</span>
        </button>
        {#each g.children as c (c.label)}
          <button
            class="sb-row child" class:clickable={!!c.onClick} disabled={!c.onClick}
            onmouseenter={() => (hovered = c.label)} onmouseleave={() => (hovered = null)} onclick={c.onClick}
          >
            <span class="sb-swatch sm" style="background:{c.color}"></span>
            <span class="sb-label">{c.label}</span>
            <span class="sb-val">{c.value}</span>
          </button>
        {/each}
      </li>
    {/each}
  </ul>
</div>

<style>
  .sb { display: flex; align-items: flex-start; gap: var(--space-4); flex-wrap: wrap; }
  .sb-chart { position: relative; flex: none; }
  .sb-chart svg { width: 100%; height: 100%; display: block; }
  .seg { transition: opacity var(--motion-duration-fast) var(--motion-ease-out); }
  .seg.dim { opacity: 0.25; }
  .seg.clickable { cursor: pointer; }
  .seg.clickable:hover { opacity: 1; }
  .sb-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; }
  .sb-num { font-size: 21px; font-weight: var(--fw-bold); color: var(--color-text-primary); line-height: 1; }
  .sb-sub { font-size: 9px; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.03em; }

  .sb-legend { flex: 1; min-width: 160px; display: flex; flex-direction: column; gap: 1px; }
  .sb-grp { display: flex; flex-direction: column; }
  .sb-row { display: flex; align-items: center; gap: var(--space-2); width: 100%; padding: 3px var(--space-2); border-radius: var(--radius-sm); background: transparent; text-align: left; }
  .sb-row.group { margin-top: 4px; }
  .sb-row.group:first-child { margin-top: 0; }
  .sb-row.child { padding-left: var(--space-4); }
  .sb-row.clickable { cursor: pointer; }
  .sb-row.clickable:hover { background: var(--color-surface-sunken); }
  .sb-swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
  .sb-swatch.sm { width: 8px; height: 8px; border-radius: 2px; }
  .sb-row.group .sb-label { font-weight: var(--fw-semibold); color: var(--color-text-primary); }
  .sb-label { flex: 1; min-width: 0; font-size: var(--text-body-sm); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sb-val { font-size: var(--text-body-sm); font-weight: var(--fw-semibold); color: var(--color-text-primary); font-variant-numeric: tabular-nums; flex: none; }
</style>
