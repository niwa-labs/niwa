import "./styles.css";

import { mountCockpit } from "./boot.tsx";

const container = document.getElementById("root");
if (container === null) throw new Error("the page has no element to draw the cockpit in");
document.documentElement.classList.add("dark");
void mountCockpit(container);
