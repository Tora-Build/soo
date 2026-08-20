// soo.sooth.market -> the Pages deployment, verbatim.
//
// Same method, headers and body in; same status, headers and body out.
// The only change is the hostname, so the Pages edge serves the request
// it would have served had the custom domain attached directly.

const ORIGIN = "soo-aif.pages.dev";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = ORIGIN;
    return fetch(new Request(url, request));
  },
};
