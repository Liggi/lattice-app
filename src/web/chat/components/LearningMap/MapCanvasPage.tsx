/**
 * `/map/:mapId` and `/map/:mapId/article/:articleId` both land here: the split
 * workspace owns the map/article layout, so this file is only the route entry.
 */
export { MapWorkspace as MapCanvasPage } from './MapWorkspace';
