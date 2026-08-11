#!/usr/bin/env python3
"""
Semi-Monthly Driver Assignment Optimizer
=========================================
1. Loads patient coordinates per store + historical delivery counts
2. Generates a projected 15-day delivery dataset using real patient locations
3. For each driver-store assignment, computes total loop distance using nearest-neighbor TSP
4. Compares current vs optimized assignments
"""
import json, math, random, os, datetime
from collections import defaultdict

def haversine(lat1, lon1, lat2, lon2):
    R = 6371
    dlat, dlon = math.radians(lat2-lat1), math.radians(lon2-lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

def nearest_neighbor_tsp(start_lat, start_lon, points, end_lat=None, end_lon=None):
    if not points:
        if end_lat is not None:
            return haversine(start_lat, start_lon, end_lat, end_lon)
        return 0
    remaining = list(range(len(points)))
    current_lat, current_lon = start_lat, start_lon
    total_dist = 0
    while remaining:
        min_dist = float('inf')
        min_idx = 0
        for i, idx in enumerate(remaining):
            d = haversine(current_lat, current_lon, points[idx][0], points[idx][1])
            if d < min_dist:
                min_dist = d
                min_idx = i
        nearest = remaining.pop(min_idx)
        total_dist += min_dist
        current_lat, current_lon = points[nearest][0], points[nearest][1]
    if end_lat is not None:
        total_dist += haversine(current_lat, current_lon, end_lat, end_lon)
    else:
        total_dist += haversine(current_lat, current_lon, start_lat, start_lon)
    return total_dist

DRIVERS = [
    {"id": "68570f3cd01bfa2d2408a9d7", "name": "Robert T", "lat": 53.4024845, "lon": -113.5796823, "pay": 6.15, "role": "primary"},
    {"id": "696825d8ffeeeb3965f2db70", "name": "Sharuk", "lat": 53.4843478, "lon": -113.5100505, "pay": 5.50, "role": "primary"},
    {"id": "6a0530f5d3e4aaf2e4095309", "name": "Erin", "lat": 53.48225957059834, "lon": -113.50388457216759, "pay": 5.25, "role": "secondary"},
    {"id": "6a41857fe03681a2a1d3ca7b", "name": "Anna", "lat": 53.479975, "lon": -113.457778, "pay": 6.15, "role": "secondary"},
]
DRIVER_MAP = {d["id"]: d for d in DRIVERS}

STORES = [
    {"id": "695b6333e8a9b6f5b0c467d7", "name": "Lakeland Ridge", "abbr": "LR", "lat": 53.5422291, "lon": -113.2674898,
     "am": {"start": "12:00", "end": "12:30", "driver": "696825d8ffeeeb3965f2db70"},
     "pm": {"start": "17:00", "end": "17:30", "driver": "696825d8ffeeeb3965f2db70"}, "avg_am": 4, "avg_pm": 4},
    {"id": "69354c3f7d5201849e84af97", "name": "Sherwood Pk Mall", "abbr": "SM", "lat": 53.532611, "lon": -113.2939723,
     "am": {"start": "11:30", "end": "12:00", "driver": "696825d8ffeeeb3965f2db70"},
     "pm": {"start": "17:30", "end": "18:00", "driver": "696825d8ffeeeb3965f2db70"}, "avg_am": 7, "avg_pm": 7},
    {"id": "685cd33055969a07cb634fe9", "name": "Beverly", "abbr": "BS", "lat": 53.5705384, "lon": -113.4007079,
     "am": None, "pm": {"start": "14:00", "end": "15:30", "driver": "68570f3cd01bfa2d2408a9d7"},
     "sat_am": {"start": "10:00", "end": "12:00", "driver": "696825d8ffeeeb3965f2db70"}, "avg_pm": 8},
    {"id": "685cd33055969a07cb634fe8", "name": "WestPark", "abbr": "WP", "lat": 53.6820807, "lon": -113.2476868,
     "am": {"start": "12:00", "end": "13:00", "driver": "6a41857fe03681a2a1d3ca7b"}, "pm": None, "avg_am": 3},
    {"id": "685cd33055969a07cb634fe7", "name": "SouthPoint", "abbr": "SP", "lat": 53.6947782, "lon": -113.21636,
     "am": {"start": "13:00", "end": "14:00", "driver": "6a41857fe03681a2a1d3ca7b"}, "pm": None, "avg_am": 2},
    {"id": "685cd33055969a07cb634fe6", "name": "Callingwood", "abbr": "CW", "lat": 53.5016037, "lon": -113.6288272,
     "am": {"start": "12:00", "end": "13:00", "driver": "68570f3cd01bfa2d2408a9d7"}, "pm": None, "avg_am": 7},
    {"id": "685cd33055969a07cb634fe5", "name": "Hamptons", "abbr": "HS", "lat": 53.4954693, "lon": -113.6659074,
     "am": {"start": "10:00", "end": "11:00", "driver": "68570f3cd01bfa2d2408a9d7"}, "pm": None, "avg_am": 5},
    {"id": "685cd33055969a07cb634fe4", "name": "Londonderry", "abbr": "LD", "lat": 53.6012949, "lon": -113.4468583,
     "am": None, "pm": {"start": "16:00", "end": "17:00", "driver": "68570f3cd01bfa2d2408a9d7"}, "avg_pm": 7},
    {"id": "685cd33055969a07cb634fe3", "name": "Meadows", "abbr": "MD", "lat": 53.4552334, "lon": -113.3786324,
     "am": None, "pm": {"start": "15:00", "end": "16:00", "driver": "6a41857fe03681a2a1d3ca7b"}, "avg_pm": 5},
    {"id": "685cd33055969a07cb634fe2", "name": "Bonnie Doon", "abbr": "BD", "lat": 53.5204309, "lon": -113.4578861,
     "am": {"start": "11:00", "end": "12:00", "driver": "696825d8ffeeeb3965f2db70"},
     "pm": {"start": "16:30", "end": "17:30", "driver": "696825d8ffeeeb3965f2db70"}, "avg_am": 10, "avg_pm": 10},
    {"id": "685cd33055969a07cb634fe1", "name": "Scona", "abbr": "SC", "lat": 53.516657, "lon": -113.4966775,
     "am": None, "pm": {"start": "14:00", "end": "15:00", "driver": "6a0530f5d3e4aaf2e4095309"}, "avg_pm": 5},
    {"id": "685cd33055969a07cb634fe0", "name": "Kingsway", "abbr": "KW", "lat": 53.5633715, "lon": -113.5068197,
     "am": {"start": "09:15", "end": "09:45", "driver": "696825d8ffeeeb3965f2db70"}, "pm": None,
     "sat_am": {"start": "11:00", "end": "12:00", "driver": "696825d8ffeeeb3965f2db70"},
     "sun_am": {"start": "10:00", "end": "11:00", "driver": "696825d8ffeeeb3965f2db70"}, "avg_am": 9},
]
STORE_MAP = {s["id"]: s for s in STORES}

# Calendar: Aug 1-15, 2026
CALENDAR = []
for day in range(1, 16):
    d = datetime.date(2026, 8, day)
    python_dow = d.weekday()
    if python_dow < 5: day_type = "weekday"
    elif python_dow == 5: day_type = "sat"
    else: day_type = "sun"
    CALENDAR.append({"day": day, "dow": python_dow, "type": day_type})

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def load_patient_coords():
    coords = defaultdict(list)
    filepath = os.path.join(BASE_DIR, "patient_coords.json")
    if os.path.exists(filepath):
        with open(filepath) as f:
            data = json.load(f)
        for store_id, patients in data.items():
            coords[store_id] = [(p["lat"], p["lon"]) for p in patients if p.get("lat") and p.get("lon")]
    return dict(coords)

def generate_projected_deliveries(patient_coords):
    random.seed(42)
    projected = {}
    for cal_day in CALENDAR:
        day = cal_day["day"]
        day_type = cal_day["type"]
        projected[day] = {}
        for store in STORES:
            sid = store["id"]
            coords = patient_coords.get(sid, [])
            if not coords: continue
            slots = []
            if day_type == "weekday":
                if store.get("am"): slots.append(("AM", store.get("avg_am", 5)))
                if store.get("pm"): slots.append(("PM", store.get("avg_pm", 5)))
            elif day_type == "sat":
                if store.get("sat_am"): slots.append(("SAT_AM", store.get("avg_am", 5)))
            elif day_type == "sun":
                if store.get("sun_am"): slots.append(("SUN_AM", store.get("avg_am", 5)))
            if not slots: continue
            day_deliveries = {}
            for slot, base_count in slots:
                count = max(1, int(base_count * random.uniform(0.8, 1.2)))
                if len(coords) >= count:
                    sampled = random.sample(coords, count)
                else:
                    sampled = random.choices(coords, k=count)
                day_deliveries[slot] = sampled
            projected[day][sid] = day_deliveries
    return projected

def compute_driver_day_route(driver, stores_with_points, slot_label):
    """
    Compute one driver's loop distance for one slot (AM or PM).
    stores_with_points = [(store, [patient_points]), ...] sorted by pickup time.
    Route: Home → Store1 → deliver → Store2 → deliver → ... → Home
    """
    if not stores_with_points:
        return 0, 0
    
    total_dist = 0
    total_deliveries = 0
    current_lat, current_lon = driver["lat"], driver["lon"]
    
    for i, (store, pts) in enumerate(stores_with_points):
        # Drive to store
        total_dist += haversine(current_lat, current_lon, store["lat"], store["lon"])
        current_lat, current_lon = store["lat"], store["lon"]
        
        # Deliver patients
        if pts:
            if i == len(stores_with_points) - 1:
                end_lat, end_lon = driver["lat"], driver["lon"]
            else:
                next_store = stores_with_points[i+1][0]
                end_lat, end_lon = next_store["lat"], next_store["lon"]
            tsp_dist = nearest_neighbor_tsp(current_lat, current_lon, pts, end_lat, end_lon)
            total_dist += tsp_dist
            total_deliveries += len(pts)
            current_lat, current_lon = end_lat, end_lon
    
    # Ensure we return home
    if current_lat != driver["lat"] or current_lon != driver["lon"]:
        total_dist += haversine(current_lat, current_lon, driver["lat"], driver["lon"])
    
    return total_dist, total_deliveries

def compute_assignment_total(projected, assignment):
    results = {d["name"]: {"distance": 0, "deliveries": 0} for d in DRIVERS}
    
    for cal_day in CALENDAR:
        day = cal_day["day"]
        day_type = cal_day["type"]
        day_data = projected.get(day, {})
        
        for driver in DRIVERS:
            da = assignment.get(driver["id"], {})
            
            if day_type == "weekday":
                am_stores = da.get("AM", [])
                pm_stores = da.get("PM", [])
            elif day_type == "sat":
                am_stores = da.get("SAT_AM", [])
                pm_stores = []
            else:
                am_stores = da.get("SUN_AM", [])
                pm_stores = []
            
            # Build (store, points) lists, sorted by pickup window time
            for slot_label, store_ids in [("AM", am_stores), ("PM", pm_stores)]:
                stores_with_points = []
                for sid in store_ids:
                    if sid not in day_data: continue
                    slot_key = slot_label if slot_label in ("AM", "PM") else "SAT_AM"
                    pts = day_data.get(sid, {}).get(slot_key, [])
                    if not pts: continue
                    stores_with_points.append((STORE_MAP[sid], [(p[0], p[1]) for p in pts]))
                
                # Sort by pickup window start time
                if slot_label == "AM":
                    stores_with_points.sort(key=lambda x: x[0].get("am", {}).get("start", "99:99") or "99:99")
                else:
                    stores_with_points.sort(key=lambda x: x[0].get("pm", {}).get("start", "99:99") or "99:99")
                
                dist, dels = compute_driver_day_route(driver, stores_with_points, slot_label)
                results[driver["name"]]["distance"] += dist
                results[driver["name"]]["deliveries"] += dels
    
    return results

def build_current_assignment():
    assignment = {d["id"]: {"AM": [], "PM": [], "SAT_AM": [], "SUN_AM": []} for d in DRIVERS}
    for store in STORES:
        if store.get("am"): assignment[store["am"]["driver"]]["AM"].append(store["id"])
        if store.get("pm"): assignment[store["pm"]["driver"]]["PM"].append(store["id"])
        if store.get("sat_am"): assignment[store["sat_am"]["driver"]]["SAT_AM"].append(store["id"])
        if store.get("sun_am"): assignment[store["sun_am"]["driver"]]["SUN_AM"].append(store["id"])
    return assignment

def try_optimization(projected, current_assign, patient_coords):
    """
    Try swapping store slots between drivers to reduce total distance.
    Constraint: primary drivers must keep the most deliveries.
    """
    best = {"assignment": current_assign, "results": compute_assignment_total(projected, current_assign)}
    best_total = sum(r["distance"] for r in best["results"].values())
    
    # Get all store slots
    slots = []
    for store in STORES:
        if store.get("am"): slots.append(("AM", store["id"], store["am"]["driver"]))
        if store.get("pm"): slots.append(("PM", store["id"], store["pm"]["driver"]))
        if store.get("sat_am"): slots.append(("SAT_AM", store["id"], store["sat_am"]["driver"]))
        if store.get("sun_am"): slots.append(("SUN_AM", store["id"], store["sun_am"]["driver"]))
    
    # Try swapping each slot to each other driver
    improved = True
    iteration = 0
    while improved and iteration < 5:
        improved = False
        iteration += 1
        for slot_type, store_id, current_driver_id in slots:
            store = STORE_MAP[store_id]
            store_name = store["name"]
            
            for new_driver in DRIVERS:
                if new_driver["id"] == current_driver_id: continue
                
                # Skip if new driver already has too many stores in this slot
                current_count = len(best["assignment"][new_driver["id"]].get(slot_type, []))
                if current_count >= 4: continue  # Max 4 stores per slot
                
                # Try the swap
                test_assign = json.loads(json.dumps(best["assignment"]))
                test_assign[current_driver_id][slot_type] = [s for s in test_assign[current_driver_id][slot_type] if s != store_id]
                test_assign[new_driver["id"]][slot_type].append(store_id)
                
                test_results = compute_assignment_total(projected, test_assign)
                test_total = sum(r["distance"] for r in test_results.values())
                
                if test_total < best_total:
                    # Check constraint: primaries have most deliveries
                    primary_dels = sum(test_results[d["name"]]["deliveries"] for d in DRIVERS if d["role"] == "primary")
                    secondary_dels = sum(test_results[d["name"]]["deliveries"] for d in DRIVERS if d["role"] == "secondary")
                    if primary_dels > secondary_dels:
                        best = {"assignment": test_assign, "results": test_results}
                        best_total = test_total
                        improved = True
                        print(f"  Swap: {store_name} {slot_type} from {DRIVER_MAP[current_driver_id]['name']} → {new_driver['name']} (saves {best_total - test_total:.1f} km)")
    
    return best

def main():
    print("Loading patient coordinates...")
    patient_coords = load_patient_coords()
    print(f"  Loaded for {len(patient_coords)} stores")
    for sid, pts in patient_coords.items():
        print(f"    {STORE_MAP.get(sid, {}).get('name', sid)}: {len(pts)} patients")
    
    print("\nGenerating projected 15-day delivery dataset...")
    projected = generate_projected_deliveries(patient_coords)
    total_del = sum(len(day_data.get(sid, {}).get(slot, []))
                    for day_data in projected.values()
                    for sid in day_data
                    for slot in day_data[sid])
    print(f"  Total projected deliveries: {total_del}")
    
    print("\nComputing current assignment routes...")
    current_assign = build_current_assignment()
    current_results = compute_assignment_total(projected, current_assign)
    
    print("\n" + "=" * 80)
    print("CURRENT ASSIGNMENT — Semi-Monthly Route Analysis (Aug 1-15)")
    print("=" * 80)
    total_dist = 0
    total_dels = 0
    for d in DRIVERS:
        r = current_results[d["name"]]
        income = r["deliveries"] * d["pay"]
        total_dist += r["distance"]
        total_dels += r["deliveries"]
        stores = []
        for slot in ["AM", "PM", "SAT_AM", "SUN_AM"]:
            for sid in current_assign[d["id"]].get(slot, []):
                stores.append(f"{STORE_MAP[sid]['name']}({slot})")
        print(f"  {d['name']:<12} {r['deliveries']:>4} del  {r['distance']:>8.1f} km  ${income:>8.2f}  [{', '.join(stores)}]")
    print(f"  {'TOTAL':<12} {total_dels:>4} del  {total_dist:>8.1f} km")
    
    print("\nRunning optimization (swapping store slots between drivers)...")
    opt = try_optimization(projected, current_assign, patient_coords)
    opt_results = opt["results"]
    
    print("\n" + "=" * 80)
    print("OPTIMIZED ASSIGNMENT — Semi-Monthly Route Analysis (Aug 1-15)")
    print("=" * 80)
    opt_total_dist = 0
    opt_total_dels = 0
    for d in DRIVERS:
        r = opt_results[d["name"]]
        income = r["deliveries"] * d["pay"]
        opt_total_dist += r["distance"]
        opt_total_dels += r["deliveries"]
        stores = []
        for slot in ["AM", "PM", "SAT_AM", "SUN_AM"]:
            for sid in opt["assignment"][d["id"]].get(slot, []):
                stores.append(f"{STORE_MAP[sid]['name']}({slot})")
        cr = current_results[d["name"]]
        d_dist = r["distance"] - cr["distance"]
        d_dels = r["deliveries"] - cr["deliveries"]
        print(f"  {d['name']:<12} {r['deliveries']:>4} del ({d_dels:+d})  {r['distance']:>8.1f} km ({d_dist:+.1f})  ${income:>8.2f}  [{', '.join(stores)}]")
    print(f"  {'TOTAL':<12} {opt_total_dels:>4} del  {opt_total_dist:>8.1f} km")
    
    print(f"\n  Driving saved: {total_dist - opt_total_dist:.1f} km per semi-monthly cycle")
    print(f"  Annual savings: {(total_dist - opt_total_dist) * 24:.0f} km/year")
    
    # Save results
    output = {
        "current": {d["name"]: {
            "deliveries": current_results[d["name"]]["deliveries"],
            "distance": round(current_results[d["name"]]["distance"], 1),
            "income": round(current_results[d["name"]]["deliveries"] * d["pay"], 2),
            "stores": [STORE_MAP[sid]["name"] for slot in ["AM","PM","SAT_AM","SUN_AM"] for sid in current_assign[d["id"]].get(slot, [])]
        } for d in DRIVERS},
        "optimized": {d["name"]: {
            "deliveries": opt_results[d["name"]]["deliveries"],
            "distance": round(opt_results[d["name"]]["distance"], 1),
            "income": round(opt_results[d["name"]]["deliveries"] * d["pay"], 2),
            "stores": [STORE_MAP[sid]["name"] for slot in ["AM","PM","SAT_AM","SUN_AM"] for sid in opt["assignment"][d["id"]].get(slot, [])]
        } for d in DRIVERS},
        "total": {
            "current_km": round(total_dist, 1),
            "optimized_km": round(opt_total_dist, 1),
            "saved_km": round(total_dist - opt_total_dist, 1),
            "annual_saved_km": round((total_dist - opt_total_dist) * 24),
        }
    }
    with open(os.path.join(BASE_DIR, "route_analysis.json"), "w") as f:
        json.dump(output, f, indent=2)
    print("\nSaved to route_analysis.json")

if __name__ == "__main__":
    main()
