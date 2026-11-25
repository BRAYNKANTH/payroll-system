// On a phone the filters of a list page fold away behind one "Filters" button, so the list itself is the first thing on the screen.
// The page puts a button.filters-toggle next to its search box, and wraps the other controls in a .filter-panel (or lets the CSS hide a form).
// On a computer the button is hidden and everything shows as before. The button carries a small count of the filters that are set.
export function wireFilters(root) {
  const toggle = root.querySelector(".filters-toggle");
  if (!toggle) return;
  const host = toggle.closest("[data-filters-host]") || toggle.parentElement;
  toggle.onclick = () => {
    const open = host.classList.toggle("filters-open");
    toggle.setAttribute("aria-expanded", String(open));
  };
}

// Shows how many filters are set (0 hides the number), so a folded panel never hides that the list is filtered.
export function filterCount(root, n) {
  const c = root.querySelector(".fcount");
  if (!c) return;
  c.hidden = !n;
  c.textContent = String(n);
}
