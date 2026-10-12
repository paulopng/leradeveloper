<script lang="ts">
  /**
   * Switch — a small on/off toggle. Extracted from the Settings → Network
   * "Offline Mode" toggle so the same control serves Settings and the agent
   * DeploymentMatrix (install/uninstall per tool). Native checkbox under the
   * hood for keyboard + a11y; the visual track/knob is purely cosmetic.
   *
   * `checked` is a one-way prop (not bound): the parent owns truth and re-renders
   * the control to match after `onToggle` resolves — so a cancelled or failed
   * action snaps the switch back to reality instead of lying about state.
   */
  let {
    checked = false,
    disabled = false,
    label,
    ariaLabel,
    onToggle,
  }: {
    checked?: boolean;
    disabled?: boolean;
    /** Optional visible text after the track. */
    label?: string;
    /** Accessible name when there's no visible label. */
    ariaLabel?: string;
    onToggle?: (next: boolean) => void;
  } = $props();

  function handle(e: Event) {
    onToggle?.((e.currentTarget as HTMLInputElement).checked);
  }
</script>

<label class="toggle" class:disabled>
  <input type="checkbox" {checked} {disabled} aria-label={ariaLabel ?? label} onchange={handle} />
  <span class="toggle-track" aria-hidden="true"></span>
  {#if label}<span class="toggle-label">{label}</span>{/if}
</label>

<style>
  .toggle { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; user-select: none; }
  .toggle.disabled { cursor: default; opacity: 0.5; }
  .toggle input { position: absolute; opacity: 0; pointer-events: none; }
  .toggle-track {
    width: 36px; height: 20px; background: var(--color-surface-sunken);
    border: 1px solid var(--color-border); border-radius: 999px; position: relative;
    transition: background-color var(--motion-duration-fast) var(--motion-ease-out);
    flex: none;
  }
  .toggle-track::after {
    content: ""; position: absolute; top: 1px; left: 1px; width: 16px; height: 16px;
    background: var(--color-surface-raised); border-radius: 50%; box-shadow: var(--shadow-xs);
    transition: transform var(--motion-duration-fast) var(--motion-ease-out);
  }
  .toggle input:checked + .toggle-track { background: var(--color-brand); border-color: var(--color-brand); }
  .toggle input:checked + .toggle-track::after { transform: translateX(16px); background: white; }
  .toggle input:focus-visible + .toggle-track { outline: 2px solid var(--color-focus, var(--color-brand)); outline-offset: 2px; }
  .toggle-label { font-size: var(--text-body); font-weight: var(--fw-medium); color: var(--color-text-primary); }

  @media (prefers-reduced-motion: reduce) {
    .toggle-track, .toggle-track::after { transition: none; }
  }
</style>
