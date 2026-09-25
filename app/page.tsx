'use client';
import { useState, useEffect, useRef } from 'react';

const STYLE_OPTIONS = [
  { id: 'balanced', label: 'מאוזן (תרבות, טבע ואוכל)' },
  { id: 'adventure', label: 'הרפתקאות וטבע 🌲' },
  { id: 'extreme', label: 'ספורט אתגרי (טיפוס, גלישה) 🧗‍♂️🏄‍♂️' },
  { id: 'foodie', label: 'קולינריה ומסעדות 🍷' },
  { id: 'relaxed', label: 'נינוח ורגוע ☕' },
  { id: 'family', label: 'משפחתי 👨‍👩‍👧‍👦' },
  { id: 'couple', label: 'זוגי / רומנטי 💕' },
  { id: 'solo', label: 'סולו 🎒' },
  { id: 'backpacker', label: 'תרמילאי ⛺' },
  { id: 'luxury', label: 'יוקרתי ✨' },
  { id: 'budget', label: 'חסכוני 🪙' },
  { id: 'sports', label: 'ספורט (כצופה במשחקים מקצועיים) ⚽' },
  { id: 'concerts', label: 'הופעות ומוזיקה חיה 🎸' },
  { id: 'leisure', label: 'פנאי (אופרה, סדנאות והצגות) 🎭' },
  { id: 'casino', label: 'קזינו 🎰' },
  { id: 'nightlife', label: 'חיי לילה 🍸' },
];

const DAY_COLORS = [
  '#6366f1', '#a855f7', '#ec4899', '#10b981', 
  '#f59e0b', '#3b82f6', '#ef4444', '#14b8a6'
];

export default function Home() {
  const [destination, setDestination] = useState('');
  const [startPoint, setStartPoint] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedStyles, setSelectedStyles] = useState<string[]>(['balanced']);
  const [customPlaces, setCustomPlaces] = useState(''); 
  const [language, setLanguage] = useState('he');
  
  const [loading, setLoading] = useState(false);
  const [itinerary, setItinerary] = useState<any>(null);
  const [error, setError] = useState('');
  const [editMode, setEditMode] = useState(false);

  const mapRef = useRef<any>(null);
  const mapInstanceRef = useRef<any>(null);
  const markersMapRef = useRef<{ [key: string]: any }>({});

  useEffect(() => {
    const saved = localStorage.getItem('savedItinerary');
    if (saved) {
      try {
        setItinerary(JSON.parse(saved));
      } catch (e) {}
    }
  }, []);

  useEffect(() => {
    if (itinerary) {
      localStorage.setItem('savedItinerary', JSON.stringify(itinerary));
    }
  }, [itinerary]);

  const toggleStyle = (id: string) => {
    if (selectedStyles.includes(id)) {
      if (selectedStyles.length > 1) {
        setSelectedStyles(selectedStyles.filter((s) => s !== id));
      }
    } else {
      setSelectedStyles([...selectedStyles, id]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setItinerary(null);
    setEditMode(false);

    if (!startDate || !endDate) {
      setError(language === 'he' ? 'נא לבחור תאריך התחלה ותאריך סיום' : 'Please select start and end dates');
      setLoading(false);
      return;
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (end < start) {
      setError(language === 'he' ? 'תאריך הסיום חייב להיות מאוחר או שווה לתאריך ההתחלה' : 'End date must be after start date');
      setLoading(false);
      return;
    }

    const diffTime = end.getTime() - start.getTime();
    const calculatedDays = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;

    try {
      const res = await fetch('/api/generate-itinerary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destination,
          startPoint,
          startDate,
          days: calculatedDays,
          travelStyle: selectedStyles.join(', '),
          customPlaces,
          language,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה ביצירת המסלול');
      setItinerary(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleActivityChange = (dayIdx: number, actIdx: number, field: string, value: string) => {
    const updatedItinerary = { ...itinerary };
    updatedItinerary.days[dayIdx].activities[actIdx][field] = value;
    setItinerary(updatedItinerary);
  };

  const handleRemoveActivity = (dayIdx: number, actIdx: number) => {
    const updatedItinerary = { ...itinerary };
    updatedItinerary.days[dayIdx].activities.splice(actIdx, 1);
    setItinerary(updatedItinerary);
  };

  const handleAddActivity = (dayIdx: number) => {
    const updatedItinerary = { ...itinerary };
    if (!updatedItinerary.days[dayIdx].activities) {
      updatedItinerary.days[dayIdx].activities = [];
    }
    updatedItinerary.days[dayIdx].activities.push({
      time: "12:00",
      name: "",
      description: "",
      category: "כללי",
      lat: "",
      lng: "",
      ticketLink: ""
    });
    setItinerary(updatedItinerary);
  };

  const handleAutoGeocode = async (dayIdx: number, actIdx: number, placeName: string) => {
    if (!placeName || placeName.trim() === '') {
      alert(language === 'he' ? 'אנא הזן את שם המקום לפני החיפוש.' : 'Please enter a place name first.');
      return;
    }

    try {
      const searchQuery = `${placeName} ${itinerary?.destination || destination}`;
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`);
      const data = await res.json();

      if (data && data.length > 0) {
        const { lat, lon } = data[0]; 
        const updatedItinerary = { ...itinerary };
        updatedItinerary.days[dayIdx].activities[actIdx].lat = parseFloat(lat).toFixed(6);
        updatedItinerary.days[dayIdx].activities[actIdx].lng = parseFloat(lon).toFixed(6);
        setItinerary(updatedItinerary);
      } else {
        alert(language === 'he' ? 'לא מצאנו קואורדינטות למקום הזה. נסה לדייק את השם (למשל להוסיף את שם העיר).' : 'Location not found. Try a more specific name.');
      }
    } catch (err) {
      console.error(err);
      alert(language === 'he' ? 'שגיאה בתקשורת עם שרת המפות.' : 'Error contacting map server.');
    }
  };

  const exportDayToGoogleMaps = (activities: any[]) => {
    const validActs = activities.filter(a => !isNaN(Number(a.lat)) && !isNaN(Number(a.lng)));
    if (validActs.length === 0) {
      alert(language === 'he' ? 'אין מיקומים חוקיים לייצוא ביום זה.' : 'No valid locations to export.');
      return;
    }
    
    const origin = `${validActs[0].lat},${validActs[0].lng}`;
    const dest = `${validActs[validActs.length - 1].lat},${validActs[validActs.length - 1].lng}`;
    const waypoints = validActs.slice(1, -1).map(a => `${a.lat},${a.lng}`).join('|');
    
    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}${waypoints ? `&waypoints=${waypoints}` : ''}`;
    window.open(url, '_blank');
  };

  const focusOnLocation = (lat: number, lng: number, key: string) => {
    if (mapInstanceRef.current && !isNaN(lat) && !isNaN(lng)) {
      mapInstanceRef.current.setView([lat, lng], 16, { animate: true });
      const marker = markersMapRef.current[key];
      if (marker) marker.openPopup();
      mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  useEffect(() => {
    if (!itinerary) return;

    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }

    const initMap = async () => {
      // @ts-ignore
      const L = window.L;
      if (!L || !mapRef.current) return;

      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
      }

      markersMapRef.current = {};
      let allPoints: [number, number][] = [];

      itinerary.days?.forEach((day: any) => {
        const acts = day.activities || day.places || day.attractions || day.schedule || day.items || [];
        acts.forEach((act: any) => {
          const lat = Number(act.lat || act.latitude);
          const lng = Number(act.lng || act.longitude);
          if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
            allPoints.push([lat, lng]);
          }
        });
      });

      const center: [number, number] = allPoints.length > 0 ? allPoints[0] : [31.0461, 34.8516];
      const map = L.map(mapRef.current).setView(center, allPoints.length > 0 ? 12 : 6);
      mapInstanceRef.current = map;

      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri'
      }).addTo(map);

      const markersGroup = L.featureGroup();

      for (let dayIdx = 0; dayIdx < (itinerary.days || []).length; dayIdx++) {
        const day = itinerary.days[dayIdx];
        const acts = day.activities || day.places || day.attractions || day.schedule || day.items || [];
        const dayColor = DAY_COLORS[dayIdx % DAY_COLORS.length];
        let dayPoints: [number, number][] = [];
        let dayOsrmCoords: string[] = [];

        acts.forEach((act: any, actIdx: number) => {
          const lat = Number(act.lat || act.latitude);
          const lng = Number(act.lng || act.longitude);
          const name = act.name || act.title || act.placeName || 'נקודה';
          
          if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
            const markerKey = `${dayIdx}-${actIdx}`;
            dayPoints.push([lat, lng]);
            dayOsrmCoords.push(`${lng},${lat}`);

            const customIcon = L.divIcon({
              className: 'custom-day-marker',
              html: `<div style="background-color: ${dayColor}; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.6); border: 2.5px solid white;">${dayIdx + 1}</div>`,
              iconSize: [34, 34],
              iconAnchor: [17, 17]
            });

            const ticketBtn = act.ticketLink && act.ticketLink.trim() !== ""
              ? `<a href="${act.ticketLink}" target="_blank" style="display:inline-block; margin-top:8px; padding:6px 12px; background:#0ea5e9; color:white; text-decoration:none; border-radius:6px; font-weight:bold; font-size:13px;">🎟️ כרטיסים</a>` 
              : '';

            const mapsBtn = `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name + ' ' + (itinerary.destination || ''))}" target="_blank" style="display:inline-block; margin-top:8px; margin-right:8px; padding:6px 12px; background:${dayColor}; color:white; text-decoration:none; border-radius:6px; font-weight:bold; font-size:13px;">📍 ניווט במפה</a>`;

            const popupContent = `
              <div style="direction: rtl; text-align: right; font-family: 'Assistant', system-ui, sans-serif; min-width: 200px;">
                <h4 style="margin: 0 0 5px 0; color: ${dayColor}; font-size: 16px;">יום ${dayIdx + 1}: ${name}</h4>
                ${act.description ? `<p style="margin: 0; font-size: 13px; color: #4b5563; line-height: 1.4;">${act.description}</p>` : ''}
                <div style="display: flex; gap: 5px; flex-wrap: wrap;">
                  ${ticketBtn}
                  ${mapsBtn}
                </div>
              </div>
            `;

            const marker = L.marker([lat, lng], { icon: customIcon }).bindPopup(popupContent);
            markersMapRef.current[markerKey] = marker;
            markersGroup.addLayer(marker);
          }
        });

        if (dayPoints.length > 1) {
          try {
            const coordsString = dayOsrmCoords.join(';');
            const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordsString}?overview=full&geometries=geojson`);
            const data = await res.json();

            if (data.routes && data.routes[0]) {
              const routeCoordinates = data.routes[0].geometry.coordinates.map((coord: [number, number]) => [coord[1], coord[0]]);
              L.polyline(routeCoordinates, {
                color: dayColor, weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round'
              }).addTo(map);
            } else {
              L.polyline(dayPoints, { color: dayColor, weight: 4, opacity: 0.8, dashArray: '6, 6' }).addTo(map);
            }
          } catch (e) {
            L.polyline(dayPoints, { color: dayColor, weight: 4, opacity: 0.8, dashArray: '6, 6' }).addTo(map);
          }
        }
      }

      markersGroup.addTo(map);
      if (allPoints.length > 0) map.fitBounds(markersGroup.getBounds().pad(0.2));
    };

    if (!(window as any).L) {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.async = true;
      script.onload = initMap;
      document.body.appendChild(script);
    } else {
      initMap();
    }
  }, [itinerary]); 

  return (
    <>
      <style dangerouslySetInnerHTML={{__html: `
        @import url('https://fonts.googleapis.com/css2?family=Assistant:wght@300;400;600;700;800&display=swap');
      `}} />
      
      {/* תמונת רקע של חו"ל עם כיסוי כהה ואלגנטי */}
      <div className="min-h-screen relative" dir={language === 'he' ? 'rtl' : 'ltr'} style={{ fontFamily: "'Assistant', sans-serif" }}>
        
        <div 
          className="absolute inset-0 z-0 bg-cover bg-center bg-fixed opacity-40" 
          style={{ backgroundImage: "url('https://images.unsplash.com/photo-1436491865332-7a61a109cc05?q=80&w=2074&auto=format&fit=crop')" }}
        ></div>
        <div className="absolute inset-0 z-0 bg-gradient-to-b from-slate-900/80 via-slate-900/90 to-slate-950"></div>

        <main className="relative z-10 py-12 px-4 sm:px-6 lg:px-8 text-gray-100">
          <div className="max-w-4xl mx-auto">
            
            <div className="text-center mb-10 flex flex-col items-center">
              <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-4 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-sky-200 text-sm font-medium shadow-sm">
                <span>✨</span> AI-Powered Itinerary Generator
              </div>
              
              <div className="flex items-center justify-center gap-3 mb-3">
                <div className="w-12 h-12 rounded-xl bg-sky-500/20 backdrop-blur-md border border-sky-400/30 flex items-center justify-center shadow-lg text-2xl">
                  ✈️
                </div>
                <h1 className="text-4xl sm:text-6xl font-bold text-white tracking-normal drop-shadow-md">
                  VoyageAI
                </h1>
              </div>
              <p className="text-lg text-sky-200/90 max-w-xl mx-auto font-medium">
                {language === 'he' ? 'תכנון מסע חכם, מדויק ומותאם אישית בשניות.' : 'Smart, precise, and personalized travel planning in seconds.'}
              </p>
            </div>

            <div className="bg-slate-900/60 backdrop-blur-xl rounded-3xl p-8 shadow-2xl border border-white/10 mb-10">
              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-semibold text-sky-100 mb-2">
                      {language === 'he' ? 'יעד הטיול (מדינה / עיר)' : 'Destination (Country / City)'}
                    </label>
                    <input
                      type="text" required value={destination} onChange={(e) => setDestination(e.target.value)}
                      placeholder={language === 'he' ? 'לדוגמה: פורטוגל, פריז...' : 'e.g., Paris, Japan...'}
                      className="w-full px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-600 text-white placeholder-sky-300/40 focus:ring-2 focus:ring-sky-400 focus:outline-none transition-all shadow-inner"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-sky-100 mb-2">
                      {language === 'he' ? 'נקודת התחלה (שדה תעופה / עיר)' : 'Starting Point (Airport / City)'}
                    </label>
                    <input
                      type="text" value={startPoint} onChange={(e) => setStartPoint(e.target.value)}
                      placeholder={language === 'he' ? 'לדוגמה: ליסבון' : 'e.g., Lisbon'}
                      className="w-full px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-600 text-white placeholder-sky-300/40 focus:ring-2 focus:ring-sky-400 focus:outline-none transition-all shadow-inner"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <label className="block text-sm font-semibold text-sky-100 mb-2">
                      {language === 'he' ? 'תאריך התחלה' : 'Start Date'}
                    </label>
                    <input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-600 text-white focus:ring-2 focus:ring-sky-400 focus:outline-none transition-all shadow-inner" />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-sky-100 mb-2">
                      {language === 'he' ? 'תאריך סיום' : 'End Date'}
                    </label>
                    <input type="date" required value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-600 text-white focus:ring-2 focus:ring-sky-400 focus:outline-none transition-all shadow-inner" />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-sky-100 mb-2">
                      {language === 'he' ? 'שפת פלט' : 'Language'}
                    </label>
                    <select value={language} onChange={(e) => setLanguage(e.target.value)} className="w-full px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-600 text-white focus:ring-2 focus:ring-sky-400 focus:outline-none transition-all shadow-inner">
                      <option value="he">עברית</option>
                      <option value="en">English</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-sky-100 mb-2">
                    {language === 'he' ? 'ייבוא מקומות מ-Google Maps (אופציונלי):' : 'Saved places / Google Maps link (Optional):'}
                  </label>
                  <textarea
                    value={customPlaces}
                    onChange={(e) => setCustomPlaces(e.target.value)}
                    placeholder={language === 'he' ? 'לדוגמה: הדבק כאן לינק לרשימה שמורה או הקלד רשימת מקומות שחובה לשלב במסלול...' : 'e.g., paste list or link here...'}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-600 text-white placeholder-sky-300/40 focus:ring-2 focus:ring-sky-400 focus:outline-none transition-all shadow-inner h-24 resize-none"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-sky-100 mb-2">
                    {language === 'he' ? 'סגנונות טיול (ניתן לבחור כמה שתרצה):' : 'Travel Styles (Select multiple):'}
                  </label>
                  <div className="flex flex-wrap gap-2.5">
                    {STYLE_OPTIONS.map((style) => {
                      const isSelected = selectedStyles.includes(style.id);
                      return (
                        <button
                          key={style.id} type="button" onClick={() => toggleStyle(style.id)}
                          className={`px-4 py-2 rounded-xl text-sm font-medium transition-all cursor-pointer ${
                            isSelected ? 'bg-sky-500 text-white shadow-lg font-bold border border-sky-300' : 'bg-slate-800/50 text-sky-100 hover:bg-slate-700/50 border border-slate-600'
                          }`}
                        >
                          {style.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <button
                  type="submit" disabled={loading}
                  className="w-full py-4 bg-sky-600 text-white font-extrabold rounded-2xl shadow-xl hover:bg-sky-500 transition-all duration-200 disabled:opacity-50 cursor-pointer text-lg tracking-wide"
                >
                  {loading ? (language === 'he' ? 'יוצר עבורך מסלול מדהים... ✈️' : 'Generating your amazing trip... ✈️') : (language === 'he' ? 'צור מסלול טיול 🚀' : 'Generate Itinerary 🚀')}
                </button>
              </form>

              {error && (
                <div className="mt-4 p-4 bg-red-500/25 border border-red-400 text-red-200 rounded-xl text-center font-medium">
                  {error}
                </div>
              )}
            </div>

            {itinerary && (
              <div className="space-y-8">
                <div className="bg-slate-900/60 backdrop-blur-xl rounded-3xl p-4 shadow-2xl border border-white/10 overflow-hidden">
                  <div className="flex items-center justify-between mb-3 px-2">
                    <h3 className="text-xl font-bold text-white flex items-center gap-2">
                      🗺️ {language === 'he' ? 'מפת לווין גלובלית ונתיבי נסיעה לפי צבעי ימים' : 'Satellite Route Map'}
                    </h3>
                  </div>
                  <div ref={mapRef} className="w-full h-80 rounded-2xl z-10" />
                </div>

                <div className="bg-slate-900/60 backdrop-blur-xl rounded-3xl p-8 shadow-2xl border border-white/10">
                  
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
                    <h2 className="text-3xl font-bold text-white">
                      {itinerary.tripTitle || itinerary.destination || (language === 'he' ? 'מסלול הטיול שלך' : 'Your Itinerary')}
                    </h2>
                    <button 
                      onClick={() => setEditMode(!editMode)} 
                      className={`px-5 py-2 rounded-xl text-sm font-bold shadow-md transition-all border flex items-center gap-2 ${
                        editMode ? 'bg-sky-500 text-white border-sky-400 hover:bg-sky-400' : 'bg-slate-800 text-sky-200 border-slate-600 hover:bg-slate-700'
                      }`}
                    >
                      {editMode ? (language === 'he' ? '💾 שמור וסיים עריכה' : '💾 Done Editing') : (language === 'he' ? '✏️ ערוך מסלול' : '✏️ Edit Mode')}
                    </button>
                  </div>

                  <p className="text-sky-100 mb-6 leading-relaxed text-base">
                    {itinerary.summary || itinerary.overview || ''}
                  </p>

                  {itinerary.hotelRecommendation && (
                    <div className="bg-slate-800/90 border border-sky-500/50 rounded-2xl p-6 mb-8 shadow-xl">
                      <h3 className="text-xl font-bold text-white mb-2 flex items-center gap-2">
                        🏨 {language === 'he' ? 'המלצת לינה במרכז העיר' : 'Accommodation Recommendation'}
                      </h3>
                      <p className="text-white leading-relaxed text-base font-medium mb-4" dir="auto">
                        {itinerary.hotelRecommendation}
                      </p>
                      
                      {itinerary.bookingLink && (
                        <a href={itinerary.bookingLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#003580] text-white font-bold rounded-xl hover:bg-[#00224f] transition-colors shadow-md">
                          🧳 חפש לינה ב-Booking.com
                        </a>
                      )}
                    </div>
                  )}

                  <div className="space-y-6">
                    {(itinerary.days || itinerary.itinerary || []).map((day: any, index: number) => {
                      const activities = day.activities || day.places || day.attractions || day.schedule || day.items || [];
                      const dayColor = DAY_COLORS[index % DAY_COLORS.length];
                      
                      return (
                        <div key={index} className="bg-slate-800/50 rounded-2xl p-6 border border-white/5 shadow-sm transition-all">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                            <div className="flex items-center gap-3">
                              <span className="px-4 py-1.5 text-white font-bold rounded-full text-sm shadow-md" style={{ backgroundColor: dayColor }}>
                                {language === 'he' ? `יום ${day.day || index + 1}` : `Day ${day.day || index + 1}`}
                              </span>
                              <span className="text-lg font-semibold text-sky-200">
                                {day.title || day.theme || day.dayTitle || ''}
                              </span>
                            </div>
                            
                            <button 
                              onClick={() => exportDayToGoogleMaps(activities)}
                              className="px-4 py-1.5 bg-green-500/20 text-green-300 border border-green-500/40 rounded-xl text-xs font-bold hover:bg-green-500/30 transition-colors shadow-sm flex items-center justify-center gap-2"
                            >
                              🗺️ {language === 'he' ? 'ייצא יום ל-Google Maps' : 'Export Day to Maps'}
                            </button>
                          </div>

                          <div className="space-y-4">
                            {activities.length > 0 ? (
                              activities.map((act: any, actIdx: number) => {
                                const actName = act.name || act.title || act.placeName || 'פעילות';
                                const actDesc = act.description || act.details || act.summary || '';
                                const actTime = act.time || act.hour || '';
                                const actCategory = act.category || act.type || '';
                                const actLat = Number(act.lat || act.latitude);
                                const actLng = Number(act.lng || act.longitude);
                                const markerKey = `${index}-${actIdx}`;

                                return editMode ? (
                                  <div key={actIdx} className="bg-slate-800 p-4 rounded-xl shadow-inner border border-sky-500/30 flex flex-col gap-3">
                                    <div className="flex flex-wrap sm:flex-nowrap gap-2">
                                      <input 
                                        type="text" value={actTime} onChange={e => handleActivityChange(index, actIdx, 'time', e.target.value)} 
                                        className="w-24 bg-slate-700 text-white text-sm p-2.5 rounded-lg border border-slate-600 focus:outline-none focus:border-sky-400" placeholder="שעה" 
                                      />
                                      <input 
                                        type="text" value={actName} onChange={e => handleActivityChange(index, actIdx, 'name', e.target.value)} 
                                        className="flex-1 bg-slate-700 text-white text-sm p-2.5 rounded-lg border border-slate-600 focus:outline-none focus:border-sky-400 min-w-[150px]" placeholder="שם הפעילות (עברית ואנגלית)" 
                                      />
                                      <button onClick={() => handleRemoveActivity(index, actIdx)} className="px-4 py-2 bg-red-500/20 text-red-300 font-bold rounded-lg hover:bg-red-500/40 border border-red-500/30 transition-colors">
                                        מחק
                                      </button>
                                    </div>
                                    
                                    <textarea 
                                      value={actDesc} onChange={e => handleActivityChange(index, actIdx, 'description', e.target.value)} 
                                      className="w-full bg-slate-700 text-white text-sm p-2.5 rounded-lg border border-slate-600 h-16 resize-none focus:outline-none focus:border-sky-400" placeholder="תיאור" 
                                    />
                                    
                                    <input 
                                      type="text" value={act.ticketLink || ''} onChange={e => handleActivityChange(index, actIdx, 'ticketLink', e.target.value)} 
                                      className="w-full bg-slate-700 text-white text-sm p-2.5 rounded-lg border border-slate-600 focus:outline-none focus:border-sky-400" placeholder="לינק לכרטיסים (אופציונלי)" 
                                    />

                                    <div className="flex gap-2 items-center">
                                      <input 
                                        type="text" value={act.lat || ''} onChange={e => handleActivityChange(index, actIdx, 'lat', e.target.value)} 
                                        className="w-1/3 bg-slate-700 text-white text-sm p-2.5 rounded-lg border border-slate-600 focus:outline-none focus:border-sky-400" placeholder="Lat" 
                                      />
                                      <input 
                                        type="text" value={act.lng || ''} onChange={e => handleActivityChange(index, actIdx, 'lng', e.target.value)} 
                                        className="w-1/3 bg-slate-700 text-white text-sm p-2.5 rounded-lg border border-slate-600 focus:outline-none focus:border-sky-400" placeholder="Lng" 
                                      />
                                      <button 
                                        onClick={() => handleAutoGeocode(index, actIdx, actName)}
                                        className="w-1/3 py-2.5 bg-sky-500/20 text-sky-300 font-bold rounded-lg hover:bg-sky-500/40 border border-sky-500/30 transition-colors text-xs flex items-center justify-center gap-1"
                                      >
                                        🎯 {language === 'he' ? 'מצא קואורדינטות' : 'Auto-Find'}
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <div 
                                    key={actIdx} 
                                    onClick={() => !isNaN(actLat) && !isNaN(actLng) && focusOnLocation(actLat, actLng, markerKey)}
                                    className="bg-slate-800 p-5 rounded-2xl shadow-sm border border-slate-700 hover:border-sky-500/50 transition-all cursor-pointer group"
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                                      <span className="font-bold text-white text-lg group-hover:text-sky-300 transition-colors" dir="auto">
                                        {actTime ? `${actTime} - ` : ''}{actName}
                                      </span>
                                      <div className="flex flex-wrap items-center gap-2">
                                        {/* כפתור הניווט החדש שמבוסס על חיפוש השם בגוגל מפס */}
                                        <a 
                                          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(actName + ' ' + (itinerary.destination || ''))}`} 
                                          target="_blank" 
                                          rel="noreferrer" 
                                          onClick={e => e.stopPropagation()} 
                                          className="text-xs px-3 py-1 text-white rounded-full font-bold shadow-sm hover:opacity-80 transition-all flex items-center gap-1" 
                                          style={{ backgroundColor: dayColor }}
                                        >
                                          📍 {language === 'he' ? 'נווט למקום' : 'Navigate'}
                                        </a>

                                        {/* כפתור כרטיסים */}
                                        {act.ticketLink && act.ticketLink.trim() !== "" && (
                                          <a href={act.ticketLink} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-xs px-3 py-1 bg-sky-600 text-white rounded-full font-bold hover:bg-sky-500 transition-colors">
                                            🎟️ כרטיסים
                                          </a>
                                        )}

                                        {actCategory && (
                                          <span className="text-xs px-3 py-1 bg-slate-700 text-sky-200 rounded-full font-medium border border-slate-600">
                                            {actCategory}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    {actDesc && (
                                      <p className="text-slate-300 text-sm leading-relaxed" dir="auto">{actDesc}</p>
                                    )}
                                  </div>
                                );
                              })
                            ) : (
                              <p className="text-slate-400 text-sm">
                                {language === 'he' ? 'אין פעילויות רשומות ליום זה.' : 'No activities recorded for this day.'}
                              </p>
                            )}

                            {editMode && (
                              <button 
                                onClick={() => handleAddActivity(index)}
                                className="w-full mt-2 py-3 bg-slate-800 text-sky-400 border border-slate-600 rounded-xl text-sm font-bold hover:bg-slate-700 transition-colors border-dashed"
                              >
                                ➕ {language === 'he' ? 'הוסף תחנה חדשה' : 'Add New Stop'}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  );
}