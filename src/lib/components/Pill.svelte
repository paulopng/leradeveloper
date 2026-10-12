<script lang="ts">
  import type { Snippet } from "svelte";

  type Tone = "neutral" | "formula" | "cask" | "success" | "warning" | "danger" | "info" | "brand";

  interface Props {
    tone?: Tone;
    children: Snippet;
  }

  let { tone = "neutral", children }: Props = $props();
</script>

<span class="pill tone-{tone}">{@render children()}</span>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-caption);
    font-weight: var(--fw-medium);
    text-transform: lowercase;
    letter-spacing: 0.02em;
    line-height: 1;
    white-space: nowrap;
    border: 1px solid transparent;
  }
  /* Pill foregrounds use the dedicated -on-subtle tokens that clear WCAG 1.4.3 AA
     (≥ 4.5:1 for 11px caption text) on their matching -subtle backgrounds in both
     light and dark mode. See tokens.css for the contrast math. */
  .tone-neutral { background: var(--color-surface-sunken); color: var(--color-text-secondary); border-color: var(--color-border); }
  .tone-formula { background: var(--color-info-subtle); color: var(--color-formula-on-subtle); }
  .tone-cask    { background: var(--color-brand-subtle); color: var(--color-cask-on-subtle); }
  .tone-success { background: var(--color-success-subtle); color: var(--color-success-on-subtle); }
  .tone-warning { background: var(--color-warning-subtle); color: var(--color-warning-on-subtle); }
  .tone-danger  { background: var(--color-danger-subtle); color: var(--color-danger-on-subtle); }
  .tone-info    { background: var(--color-info-subtle); color: var(--color-info-on-subtle); }
  .tone-brand   { background: var(--color-brand-subtle); color: var(--color-cask-on-subtle); }
</style>
