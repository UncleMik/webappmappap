/* Keep the supplied artwork intact; compensate for its transparent margins. */
(() => {
  const frames = {
    "fbbbf86a3529bab60b6567132477ab48883a705d80f5465b88079aa9d8460c8a.webp": [23, 16, 376, 379],
    "af32a65822a75cc3db670263f11ebf361af01dadb6435af49ad066059fc599b8.webp": [47, 51, 345, 349],
    "985d21d225f263e0a5045a8e55b37b7c2e214add9cd9f37b887fa772237d0081.webp": [52, 59, 345, 353],
    "aedd7c4b094ca465194bfe9e08fa8c281c2bcc54902f527b4014853a8b6a0a1e.webp": [71, 57, 333, 337],
    "7e6f8aa76de45a86281bd3431a713451a287ce76b3f9aef9b7f0ccd8698f09fa.webp": [64, 36, 341, 362],
    "f922564c8ebc07b2f6a26cd58101c40d4037754d2515faecc3a41ed3bd5a841a.webp": [59, 32, 342, 364],
    "7a080b61fbb50a68eb1f7748d33b34cbb5c7f0da5753a16f6df27c217e6b3001.webp": [61, 33, 345, 368],
    "5e649457a20f994a6535afefa534bf696b8b8c353a11be658bc271900b4497ac.webp": [54, 37, 362, 374],
    "94898b9efd6ad7e1c07662877b00421c4ac600c322c3890065673bf087189f35.webp": [68, 32, 357, 377],
    "5ff740ba99c5952d19fb618f3baaadd80a112a8329bdc6749c57846c150a1166.webp": [75, 31, 355, 374],
    "7d0924ed6bc6e35cd944a0ca6474d408a60b9dd48d3d6c595411492dc3f8747e.webp": [5, 0, 397, 400],
    "ee667d60fc59220907e01d16d6cfaa77f9073b5cc56e3a013043a3ae1b790ff1.webp": [74, 22, 343, 371],
    "996cbbee3f69d217dee627b4768dbe3e4528cbd767b64b02a462f0268bdfaa08.webp": [70, 31, 341, 370],
    "4f90bc1ca12fe7c33ab16bd67bf50ac8e2af01af2929ad00970b8117908a051a.webp": [66, 25, 352, 375],
    "1b8bd411b34040c7de96236c57d1a2c42bb84d28986e389d15a5a003171e05b4.webp": [67, 29, 359, 390],
    "b0a4c2bcdef34a5c481c18154490d2e0c5e17e8aaccb1c7527133309167d0977.webp": [62, 31, 354, 370],
    "e8dc96af33dbc46aa8db4f0363c2352c6b9eea9470cb434dd1f4704d67453c56.webp": [68, 32, 342, 368],
    "8ab325c3d5e230da26aa91672004c6787ea9fbfb7fe084038126e457d375b600.webp": [78, 30, 354, 377],
    "97b9e2dd820fa7af6be336a37bff24cf9fac222a1362b1851b9ec9e6d9599475.webp": [62, 32, 340, 374],
    "d98947f5887c96d569028fbb5fbdfba7d16d61dff3ddec7d929c77a0b036d8a6.webp": [65, 23, 342, 372],
    "3ef989e3cb8f03df42de29b7c27d77c3b184e419a1435ddc55c0cf2f3e60a983.webp": [65, 29, 357, 384],
    "725d26f1ce80a0cd38ac0f2be1b22fadc5329e4bd0861b8159a04ae1c2f7087c.webp": [72, 23, 333, 355],
    "341305b2535aa46510375130aaf2e566646f210987f4fec0141e5db0d48a4882.webp": [71, 24, 353, 362],
    "c1c6d083203a1af3219ac054ac35d1ba00b06a066adbc6da61da4e1f3e7eca70.webp": [59, 20, 337, 361],
    "178e8a525560c803e163b844bd7934b8decac8d174d25e235457bb21bb9b2411.webp": [76, 35, 351, 367],
    "06c927af8b52478195771dcd0cf438d028f839addab3c2cdbc17dcd6596c9e36.webp": [79, 26, 376, 394],
    "19cf99e1a7e93b5e8a7baecc7adbe50372a8de40a5ba0247ba78f2c3ece8fcb7.webp": [51, 13, 356, 371],
    "fd582ee745c93ee57680e7b6d87a7a8528d3f2e85d54681d9cc12dc797a07053.webp": [86, 47, 333, 349],
    "af070f0de685c054c72f408470d33a05c4a82dc9b5710e6e599723ebd9e21f02.webp": [73, 23, 336, 368],
    "c61b9004b3ea71c482f72d37dafdff24c0069ca375ab6fedf15635d1b76ce80f.webp": [71, 26, 348, 364],
    "a432db57161cf6012d052bc31bd7f8dd1ed65bf4a9f459cc1040fe5624fdb559.webp": [70, 28, 354, 363],
    "ef3f34351d19a649e03b2a40840f4b078c688d5e5e7893a5f66d92653e204a39.webp": [65, 34, 357, 370],
    "d285580de96f2bff3025d34b280b3805c8499f2073b8214a4f3fbc75fa6a7862.webp": [72, 39, 350, 368],
    "96ebfbf39eea5694b169d2289898dbdebe11c8bc07d8335ed1e3460e49396bf3.webp": [70, 29, 358, 383],
    "e6725546dbb39a4a8b1233955d77801a4fd223b2a6b074930508c40cafffd6c9.webp": [56, 26, 367, 380],
    "a886d614ad8a0254e0932a4e6e121d4b3889c9da368d94466a8b2389272d7086.webp": [88, 40, 331, 357],
    "0dfbdd900b0458cd6b8b50394927283ac5ac6514f9520b71820382fd43811ad9.webp": [58, 21, 344, 384],
    "e6a9481901d20f941a588316b56bb44d9b40852fefcecf11d72cdcfbe8bd88ed.webp": [65, 38, 358, 375],
    "ee491cb8d63b70651f2c6c46db0f75607297e0f4203331b3f28f9a1b1e169b17.webp": [60, 16, 351, 384],
    "12d91721819a6007b7519a112d56d8a0d296d3264ef5c59044fc39f4367e8e26.webp": [79, 36, 371, 387],
    "47fd25a396da9286fa077c4a5147dd7126f920bf123513031d739da932bbd98f.webp": [75, 29, 374, 382],
    "034d2a714e5be313d79c5f96b44d2f1cdc49560dc2d0556657a416e56a45dad5.webp": [76, 19, 371, 390],
  };
  const cache = new Map();
  const requests = new WeakMap();
  let ended = false;

  function load(path, priority = 'high') {
    const url = window.weeklyImageUrl(path);
    if (ended) return Promise.reject(new Error('Session ended'));
    if (!cache.has(url)) {
      const pending = fetch(url, { credentials: 'same-origin', priority, signal: AbortSignal.timeout(15000) })
        .then(async response => {
          if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
            throw new Error('Image unavailable');
          }
          const blob = await response.blob();
          if (ended) throw new Error('Session ended');
          const objectUrl = URL.createObjectURL(blob);
          const decoded = new Image();
          decoded.src = objectUrl;
          try { await decoded.decode(); }
          catch (error) { URL.revokeObjectURL(objectUrl); throw error; }
          if (ended) { URL.revokeObjectURL(objectUrl); throw new Error('Session ended'); }
          return objectUrl;
        })
        .catch(error => { cache.delete(url); throw error; });
      cache.set(url, pending);
    }
    return cache.get(url);
  }

  async function show(image, path, normalize = false) {
    const request = {};
    requests.set(image, request);
    image.hidden = true;
    if (!path) { image.removeAttribute('src'); return; }
    if (normalize) {
      const bounds = frames[path.split('/').pop()];
      const [left, top, right, bottom] = bounds || [20, 20, 380, 380];
      image.style.transform = `scale(${360 / Math.max(right - left, bottom - top)}) translate(${(200 - (left + right) / 2) / 4}%, ${(200 - (top + bottom) / 2) / 4}%)`;
    }
    try {
      const url = await load(path);
      if (ended || requests.get(image) !== request) return;
      image.src = url;
      image.hidden = false;
    } catch {
      // Leave the existing native image/alt fallback available after a failed request.
      if (ended || requests.get(image) !== request) return;
      image.src = window.weeklyImageUrl(path);
      image.hidden = false;
    }
  }

  function prefetch(library, week) {
    if (ended || document.hidden || navigator.connection?.saveData ||
        ['slow-2g', '2g'].includes(navigator.connection?.effectiveType)) return;
    for (const neighbour of [week - 1, week + 1]) {
      const content = library[neighbour];
      if (!content) continue;
      for (const path of [content.illustration, content.comparisonImage]) {
        if (path) load(path, 'low').catch(() => {});
      }
    }
  }

  function clear() {
    ended = true;
    for (const pending of cache.values()) pending.then(URL.revokeObjectURL, () => {});
    cache.clear();
    document.querySelectorAll('.baby-hero-art, .baby-size-image').forEach(image => {
      image.hidden = true;
      image.removeAttribute('src');
    });
  }
  window.addEventListener('webpril:session-ended', clear);
  window.addEventListener('pagehide', event => { if (!event.persisted) clear(); });
  window.babyIllustrations = { show, prefetch };
})();
