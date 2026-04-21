import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import { runHeadless } from "./headless.js";

const args = process.argv.slice(2);
const headless = args.includes("--non-interactive") || !process.stdout.isTTY;

if (headless) {
  void runHeadless();
} else {
  render(<App />);
}
