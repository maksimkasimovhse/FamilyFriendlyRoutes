// Requested only after an explicit location/search action. No hotel/start fallback.
export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Геолокация недоступна в этом браузере.'));
    navigator.geolocation.getCurrentPosition(position => resolve([position.coords.longitude,position.coords.latitude]),
      () => reject(new Error('Не удалось определить геопозицию. Разрешите доступ к местоположению и повторите поиск.')),
      {enableHighAccuracy:true,maximumAge:15000,timeout:10000});
  });
}
