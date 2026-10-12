<script lang="ts">
  import { onMount, tick } from "svelte";
  import Info from "@lucide/svelte/icons/info";

  /**
   * Small inline (i) icon button that opens a popover with provenance
   * info + an optional "Report an issue" link. Used in PackageDetail to
   * surface how each AI/curated field was generated without painting
   * loud labels everywhere.
   *
   * Activation: hover (mouse) or focus (keyboard). Small open/close
   * delays prevent flicker and let the user move into the popover to
   * click the report link.
   *
   * Positioning: position: fixed with viewport-aware top/left so the
   * popover escapes any ancestor `overflow: hidden` (the PackageDetail
   * `.body` clips children to its scrollport — without fixed positioning
   * the popover gets cut off at the panel edge).
   */

  interface Props {
    /** Short heading shown bold at the top of the popover. */
    title: string;
    /** Plain-text body explaining provenance. Rendered as a single <p>. */
    body: string;
    /** Tooltip / aria-label for the trigger button. */
    label?: string;
    /** When provided, the popover shows a "Report an issue" button that
     *  invokes this callback. The popover closes automatically. */
    onReport?: () => void | Promise<void>;
  }

  let { title, body, label = "About this field", onReport }: Props = $props();

  let open = $state(false);
  let triggerEl: HTMLButtonElement | undefined = $state();
  let popoverEl: HTMLDivElement | undefined = $state();
  let popoverStyle = $state("visibility: hidden;");

  // Hover/blur intent timers — keep latency forgiving so the user can
  // sweep from the trigger into the popover without it vanishing.
  const OPEN_DELAY_MS = 120;
  const CLOSE_DELAY_MS = 180;
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearOpenTimer() {
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
  }
  function clearCloseTimer() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  }

  function scheduleOpen(delay = OPEN_DELAY_MS) {
    clearCloseTimer();
    if (open || openTimer) return;
    openTimer = setTimeout(() => {
      openTimer = null;
      open = true;
    }, delay);
  }

  function scheduleClose() {
    clearOpenTimer();
    if (!open || closeTimer) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      open = false;
      popoverStyle = "visibility: hidden;";
    }, CLOSE_DELAY_MS);
  }

  function closeNow() {
    clearOpenTimer();
    clearCloseTimer();
    open = false;
    popoverStyle = "visibility: hidden;";
  }

  // After open flips true, the popover element mounts on the next tick.
  // Measure it then compute viewport-aware top/left.
  $effect(() => {
    if (!open) return;
    // tick() lets the popover element commit to the DOM so we can measure.
    void tick().then(positionPopover);
  });

  function positionPopover() {
    if (!triggerEl || !popoverEl) return;
    const r = triggerEl.getBoundingClientRect();
    const pr = popoverEl.getBoundingClientRect();
    const margin = 8;
    const gap = 6;

    let top = r.bottom + gap;
    let left = r.left + r.width / 2 - pr.width / 2;

    // Clamp horizontally inside the viewport.
    if (left < margin) left = margin;
    if (left + pr.width > window.innerWidth - margin) {
      left = window.innerWidth - margin - pr.width;
    }
    // Flip above when there isn't enough room below.
    if (top + pr.height > window.innerHeight - margin) {
      const above = r.top - gap - pr.height;
      if (above >= margin) top = above;
    }
    popoverStyle = `top: ${top}px; left: ${left}px; visibility: visible;`;
  }

  // Re-close on viewport scroll/resize — the popover's fixed position
  // won't track the trigger if the user scrolls the detail body, so
  // dismissing is the honest answer (re-hover to reopen at the right spot).
  function onScrollOrResize() {
    if (open) closeNow();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      closeNow();
      triggerEl?.focus();
    }
  }

  async function fireReport() {
    if (!onReport) return;
    closeNow();
    await onReport();
  }

  onMount(() => {
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("keydown", onKey);
      clearOpenTimer();
      clearCloseTimer();
    };
  });
</script>

<!-- No `title` attribute: the popover itself is the tooltip, and the
     native title bubble would visually collide with it on hover. The
     button's accessible name comes from `aria-label`, which screen
     readers announce on focus — keyboard users reach the same content
     via the focus-opens-popover behaviour above. WCAG-compliant. -->
<button
  bind:this={triggerEl}
  type="button"
  class="trigger"
  class:open
  aria-label={label}
  aria-haspopup="dialog"
  aria-expanded={open}
  onmouseenter={() => scheduleOpen()}
  onmouseleave={() => scheduleClose()}
  onfocus={() => scheduleOpen(0)}
  onblur={() => scheduleClose()}
  onclick={(e) => { e.stopPropagation(); open ? closeNow() : scheduleOpen(0); }}
>
  <Info size={12} aria-hidden="true" />
</button>

{#if open}
  <div
    bind:this={popoverEl}
    class="popover"
    role="dialog"
    aria-label={title}
    tabindex="-1"
    style={popoverStyle}
    onmouseenter={clearCloseTimer}
    onmouseleave={scheduleClose}
  >
    <p class="popover-title">{title}</p>
    <p class="popover-body">{body}</p>
    {#if onReport}
      <button type="button" class="report" onclick={fireReport}>
        Report an issue on GitHub
      </button>
    {/if}
  </div>
{/if}

<style>
  .trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    background: transparent;
    color: var(--color-text-muted);
    border-radius: var(--radius-full);
    cursor: help;
    vertical-align: middle;
    transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
                color var(--motion-duration-fast) var(--motion-ease-out);
  }
  .trigger:hover,
  .trigger.open {
    background: var(--color-surface-sunken);
    color: var(--color-text-primary);
  }
  .trigger:focus-visible {
    outline: 2px solid var(--color-focus, var(--color-brand));
    outline-offset: 2px;
  }

  /* position: fixed escapes any ancestor overflow:hidden. The script
     sets top/left in viewport coordinates so the popover renders
     wherever there's room next to the trigger. */
  .popover {
    position: fixed;
    z-index: 1000;
    min-width: 240px;
    max-width: 320px;
    padding: var(--space-3);
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px -4px color-mix(in oklch, black 30%, transparent);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    text-align: left;
  }
  .popover-title {
    margin: 0;
    font-size: var(--text-body-sm);
    font-weight: var(--fw-semibold);
    color: var(--color-text-primary);
  }
  .popover-body {
    margin: 0;
    font-size: var(--text-body-sm);
    color: var(--color-text-secondary);
    line-height: 1.45;
  }
  .report {
    align-self: flex-start;
    padding: 4px 8px;
    background: var(--color-surface-sunken);
    color: var(--color-text-primary);
    border-radius: var(--radius-sm);
    font-size: var(--text-body-sm);
    cursor: pointer;
    transition: background-color var(--motion-duration-fast) var(--motion-ease-out);
  }
  .report:hover {
    background: var(--color-surface);
  }
  .report:focus-visible {
    outline: 2px solid var(--color-focus, var(--color-brand));
    outline-offset: 2px;
  }
</style>
