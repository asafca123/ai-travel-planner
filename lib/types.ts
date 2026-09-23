export interface Place {
  name: string;
  description: string;
  lat: number;
  lng: number;
  time_of_day: "morning" | "afternoon" | "evening";
}

export interface Day {
  day: number;
  title: string;
  places: Place[];
}

export interface Itinerary {
  destination: string;
  days: Day[];
}