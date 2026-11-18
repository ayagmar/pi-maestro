/**
 * Install commands shown on the landing page. Git is the working install source:
 * `npm view @ayagmar/pi-maestro` returns E404 until the first release is published.
 * When it is, make the npm command primary here, in README.md, and in
 * docs/getting-started.md; test/docs.test.ts keeps the three in step.
 */
export const installCommand = "pi install git:github.com/ayagmar/pi-maestro";
export const npmInstallCommand = "pi install npm:@ayagmar/pi-maestro";
