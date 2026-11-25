import { post } from "../api.js";
import { state } from "../app.js";
import { $, html, icon, toast, busy, initials, hapticsOn, setHaptics } from "../ui.js";
import { fxMode, setFx } from "../fx.js";

export default {
  title: "My account",
  async render({ el }) {
    const u = state.user;
    el.innerHTML = html`
      <div class="page-head"><div><h1>My account</h1></div></div>
      <div class="grid halves">
        <div class="card"><div class="profile-head"><div class="avatar lg">${initials(u.full_name)}</div>
          <div><h2>${u.full_name}</h2><div class="muted">${u.username} · ${u.role}${u.hub ? ` · hub ${u.hub}` : ""}</div></div></div>
          <div class="card-body"><div class="faint" style="font-size:14px;margin-bottom:6px">You can</div>
            <div class="row" style="gap:6px">${u.permissions.map((p) => html`<span class="badge plain">${p.replace(/_/g, " ")}</span>`)}</div></div></div>
        <div class="card"><div class="card-head"><h2>On this phone</h2></div><div class="card-body">
          <label class="check-row" style="display:flex;gap:12px;align-items:center;min-height:48px;cursor:pointer"><input type="checkbox" id="haptics" ${hapticsOn() ? "checked" : ""}><span>Vibrate a little when an action works</span></label>
          <div class="field" style="margin-top:10px"><label for="fx-mode">Animations and glow</label>
            <select class="input" id="fx-mode"><option value="auto" ${fxMode() === "auto" ? "selected" : ""}>Automatic (off when your device asks for less motion)</option><option value="on" ${fxMode() === "on" ? "selected" : ""}>Always on</option><option value="off" ${fxMode() === "off" ? "selected" : ""}>Off: fastest on an older phone</option></select></div></div></div>
        <div class="card"><div class="card-head"><h2>Change password</h2></div><div class="card-body">
          <form id="pf" class="stack" style="gap:14px">
            <div class="field"><label>Current password</label><input class="input" type="password" name="current_password" autocomplete="current-password" required></div>
            <div class="field"><label>New password</label><input class="input" type="password" name="new_password" autocomplete="new-password" required><span class="hint">At least 8 characters, letters and numbers</span></div>
            <div class="field"><label>Repeat new password</label><input class="input" type="password" name="repeat" autocomplete="new-password" required></div>
            <div><button class="btn primary" id="pw">${icon("lock")} Update password</button></div>
          </form></div></div>
      </div>`;
    $("#fx-mode").onchange = (e) => { setFx(e.target.value); toast(e.target.value === "off" ? "Animations off" : e.target.value === "on" ? "Animations on" : "Animations: automatic"); };
    $("#haptics").onchange = (e) => { setHaptics(e.target.checked); toast(e.target.checked ? "Vibration on" : "Vibration off"); };
    $("#pf").onsubmit = (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      if (f.new_password !== f.repeat) return toast("The new passwords don't match", "err");
      busy($("#pw"), async () => { await post("/api/auth/password", f); e.target.reset(); toast("Password updated"); });
    };
  },
};
