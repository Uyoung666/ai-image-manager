/** Ignore preserved hidden sidebars while blocking shortcuts behind visible dialogs. */
export function cullShortcutBlocked(event: KeyboardEvent): boolean {
  if (
    event.target instanceof HTMLElement &&
    event.target.closest("input,textarea,select,[contenteditable=true]")
  ) {
    return true;
  }
  return [
    ...document.querySelectorAll('[role="dialog"],[role="alertdialog"]'),
  ].some((dialog) => {
    if (
      dialog.closest(
        '[hidden],[aria-hidden="true"],[inert],[data-state="closed"],[data-closed]'
      )
    ) {
      return false;
    }
    for (let node: Element | null = dialog; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      ) {
        return false;
      }
    }
    return true;
  });
}
