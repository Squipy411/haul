// hls.js publishes its smaller "light" build without its own type file; it shares the full build's API.
declare module 'hls.js/light' {
  export { default } from 'hls.js';
}
