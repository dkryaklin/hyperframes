import { describe, expect, it } from "vitest";
import { lintHyperframeHtml } from "../hyperframeLinter.js";

async function codes(html: string): Promise<string[]> {
  const result = await lintHyperframeHtml(html);
  return result.findings.map((f) => f.code);
}

const SHELL = `<div data-composition-id="root" data-width="1920" data-height="1080"></div>`;

describe("connector rules", () => {
  it("errors on orientation= on a marker", async () => {
    const html = `
      ${SHELL}
      <svg><defs>
        <marker id="arrowhead" orientation="auto"><polygon points="0 0, 10 3.5, 0 7" /></marker>
      </defs>
      <path id="flow-arrow" d="M 10 10 L 100 10" marker-end="url(#arrowhead)" /></svg>
      <script>window.__timelines = { root: gsap.timeline({ paused: true }) };</script>
    `;
    expect(await codes(html)).toContain("marker_orient_typo");
  });

  it("does not treat data-orientation as the typo", async () => {
    const html = `
      ${SHELL}
      <svg><defs>
        <marker id="arrowhead" orient="auto" data-orientation="foo"><polygon points="0 0, 10 3.5, 0 7" /></marker>
      </defs>
      <path id="flow-arrow" d="M 10 10 L 100 10" marker-end="url(#arrowhead)" /></svg>
      <script>window.__timelines = { root: gsap.timeline({ paused: true }) };</script>
    `;
    expect(await codes(html)).not.toContain("marker_orient_typo");
  });

  it("errors when a quoted selector draws a marked path with strokeDashoffset", async () => {
    const html = `
      ${SHELL}
      <svg>
        <defs><marker id="arrowhead" orient="auto"><polygon points="0 0, 10 3.5, 0 7" /></marker></defs>
        <path id="flow-arrow" d="M 10 50 L 200 50" marker-end="url(#arrowhead)" />
      </svg>
      <script>
        gsap.set('#flow-arrow', { strokeDasharray: 200, strokeDashoffset: 200 });
        const tl = gsap.timeline({ paused: true });
        tl.to('#flow-arrow', { strokeDashoffset: 0, duration: 1.2 }, 1.5);
        window.__timelines = { root: tl };
      </script>
    `;
    expect(await codes(html)).toContain("marker_dash_draw_on");
  });

  it("errors when a getElementById alias is the dash target", async () => {
    const html = `
      ${SHELL}
      <svg>
        <defs><marker id="arrowhead" orient="auto"><polygon points="0 0, 10 3.5, 0 7" /></marker></defs>
        <path id="path-input" d="M 40 540 L 720 540" marker-end="url(#arrowhead)" />
      </svg>
      <script>
        const pathInput = document.getElementById('path-input');
        gsap.set(pathInput, { strokeDasharray: 2000, strokeDashoffset: 2000 });
        const tl = gsap.timeline({ paused: true });
        tl.to(pathInput, { strokeDashoffset: 0, duration: 1 }, 0.5);
        window.__timelines = { root: tl };
      </script>
    `;
    expect(await codes(html)).toContain("marker_dash_draw_on");
  });

  it("errors when the alias sits in a GSAP array target", async () => {
    const html = `
      ${SHELL}
      <svg>
        <defs><marker id="arrowhead" orient="auto"><polygon points="0 0, 10 3.5, 0 7" /></marker></defs>
        <path id="path-input" d="M 40 540 L 720 540" marker-end="url(#arrowhead)" />
        <path id="path-primary" d="M 1200 540 L 1880 540" marker-end="url(#arrowhead)" />
      </svg>
      <script>
        const pathInput = document.getElementById('path-input');
        const pathPrimary = document.getElementById('path-primary');
        gsap.set([pathInput, pathPrimary], { strokeDasharray: 2000, strokeDashoffset: 2000 });
        const tl = gsap.timeline({ paused: true });
        window.__timelines = { root: tl };
      </script>
    `;
    const result = await lintHyperframeHtml(html);
    const dash = result.findings.filter((f) => f.code === "marker_dash_draw_on");
    expect(dash.map((f) => f.elementId).sort()).toEqual(["path-input", "path-primary"]);
  });

  it("does not treat a tag selector as an id hit", async () => {
    const html = `
      ${SHELL}
      <svg>
        <defs><marker id="arrowhead" orient="auto"><polygon points="0 0, 10 3.5, 0 7" /></marker></defs>
        <path id="path" d="M 10 50 L 200 50" marker-end="url(#arrowhead)" />
      </svg>
      <script>
        const tl = gsap.timeline({ paused: true });
        tl.to('path', { strokeDashoffset: 0, duration: 1 }, 0.5);
        window.__timelines = { root: tl };
      </script>
    `;
    expect(await codes(html)).not.toContain("marker_dash_draw_on");
  });

  it("does not flag a marked path when dash is on a different element", async () => {
    const html = `
      ${SHELL}
      <svg>
        <defs><marker id="arrowhead" orient="auto"><polygon points="0 0, 10 3.5, 0 7" /></marker></defs>
        <path id="flow-arrow" d="M 10 50 L 200 50" marker-end="url(#arrowhead)" />
        <path id="decor-wave" d="M 0 50 Q 50 0 100 50" />
      </svg>
      <script>
        gsap.set('#flow-arrow', { opacity: 0 });
        const tl = gsap.timeline({ paused: true });
        tl.to('#decor-wave', { strokeDashoffset: 0, duration: 1 }, 0.5);
        window.__timelines = { root: tl };
      </script>
    `;
    expect(await codes(html)).not.toContain("marker_dash_draw_on");
  });

  it("does not flag a marked path revealed by opacity only", async () => {
    const html = `
      ${SHELL}
      <svg>
        <defs><marker id="arrowhead" orient="auto"><polygon points="0 0, 10 3.5, 0 7" /></marker></defs>
        <path id="flow-arrow" d="M 10 50 L 200 50" marker-end="url(#arrowhead)" />
      </svg>
      <script>
        const tl = gsap.timeline({ paused: true });
        tl.fromTo('#flow-arrow', { opacity: 0 }, { opacity: 1, duration: 0.5 }, 0.5);
        window.__timelines = { root: tl };
      </script>
    `;
    expect(await codes(html)).not.toContain("marker_dash_draw_on");
  });
});
