/** @jsxImportSource preact */
// Page bootstrap: take the one-time login token out of the address bar before anything else, then render. Links
// opened later in the same tab are handled by Root.
import { render } from "preact";
import { Root } from "./app.tsx";
import { takeLoginToken } from "./login.ts";
import { applyTheme, storedTheme } from "./theme.ts";
import "./styles.css";

applyTheme(storedTheme());

render(<Root loginToken={takeLoginToken()} />, document.getElementById("app")!);
