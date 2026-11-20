[out:json][timeout:60];
area["name"="Нижний Новгород"]["boundary"="administrative"]["admin_level"="8"]->.city;
(
  nwr(area.city)["tourism"~"^(museum|attraction|gallery|zoo|theme_park)$"];
  nwr(area.city)["leisure"~"^(park|playground|garden|nature_reserve|sports_centre)$"];
  nwr(area.city)["amenity"~"^(restaurant|cafe|toilets|library|theatre|cinema)$"];
);
out center;
