// React fixtures: a controlled-input form and a Greenhouse-like application using react-select.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import Select from "react-select";

function ReactForm() {
  const [name, setName] = useState("");
  const [color, setColor] = useState(null);
  return (
    <form aria-label="React form" onSubmit={(e) => e.preventDefault()}>
      <label htmlFor="name">Your name</label>
      <input id="name" value={name} onChange={(e) => setName(e.target.value)} />
      <label id="color-label" htmlFor="color-input">Favorite color</label>
      <Select inputId="color-input" aria-labelledby="color-label" value={color} onChange={setColor}
        options={[{ value: "r", label: "Red" }, { value: "g", label: "Green" }, { value: "b", label: "Blue" }]} />
      <p>React state: <span id="state-name">{name}</span> / <span id="state-color">{color?.label ?? ""}</span></p>
    </form>
  );
}

const yesNo = [{ value: "1", label: "Yes" }, { value: "0", label: "No" }];

function Greenhouse() {
  const [values, setValues] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const set = (k) => (v) => setValues((s) => ({ ...s, [k]: v }));
  const field = (id, label, props = {}) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} required={label.endsWith("*")} value={values[id] ?? ""} onChange={(e) => set(id)(e.target.value)} {...props} />
    </div>
  );
  const combo = (id, label, options) => (
    <div className="field">
      <label id={`${id}-label`} htmlFor={id}>{label}</label>
      <Select inputId={id} aria-labelledby={`${id}-label`} options={options} value={values[id] ?? null} onChange={set(id)} placeholder="Select..." />
    </div>
  );
  if (submitted) return <h1>Thanks for applying</h1>;
  return (
    <main>
      <h1>Sr. Software Engineer - Backend</h1>
      <p>Lively is hiring a backend engineer. Remote (US).</p>
      <form aria-label="Apply for this job" onSubmit={(e) => { e.preventDefault(); setSubmitted(true); }}>
        {field("first_name", "First Name*")}
        {field("last_name", "Last Name*")}
        {field("email", "Email*", { type: "email" })}
        {field("phone", "Phone")}
        {combo("country", "Country*", [{ value: "us", label: "United States" }, { value: "ca", label: "Canada" }])}
        <div className="field">
          <label htmlFor="resume">Resume/CV*</label>
          <input id="resume" type="file" accept=".pdf,.doc,.docx,.txt,.rtf" required onChange={(e) => set("resume")(e.target.files[0]?.name)} />
          <span id="resume-name">{values.resume ?? ""}</span>
        </div>
        {combo("work_auth", "Are you currently authorized to work in the United States without sponsorship?*", yesNo)}
        {field("linkedin", "LinkedIn Profile*")}
        <div className="field">
          <label htmlFor="why">Why do you want to work at Lively?</label>
          <textarea id="why" value={values.why ?? ""} onChange={(e) => set("why")(e.target.value)} />
        </div>
        <h2>Voluntary Self-Identification</h2>
        {combo("gender", "Gender", [{ value: "m", label: "Male" }, { value: "f", label: "Female" }, { value: "d", label: "Decline to self-identify" }])}
        {combo("veteran", "Veteran Status", [{ value: "n", label: "I am not a protected veteran" }, { value: "d", label: "I don't wish to answer" }])}
        <button type="submit">Submit application</button>
      </form>
      <pre id="state">{JSON.stringify(values)}</pre>
    </main>
  );
}

const apps = { "react-form": ReactForm, greenhouse: Greenhouse };
const root = document.getElementById("root");
createRoot(root).render((() => { const App = apps[root.dataset.app]; return <App />; })());
