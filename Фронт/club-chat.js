// Old demo-room links return to the matching Club section.
(() => {
 const room = new URLSearchParams(location.search).get('room') || '';
 const section = room.startsWith('motherhood-') || room.startsWith('baby-') || room === 'moms'
  ? 'motherhood' : 'pregnancy';
 location.replace(new URL('club.html#' + section, location.href).href);
})();
