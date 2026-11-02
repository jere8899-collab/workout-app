// Default exercise metadata. Only used to pick sensible rep ranges and rest
// times; the user can change any variant's range in the app.
export const EXERCISE_CATALOG = {
  'Seated Leg Press': ['compound', 'quads/glutes'],
  'Hack Squat': ['compound', 'quads/glutes'],
  'Hip Thrust': ['compound', 'glutes'],
  'Deadlift': ['compound', 'posterior chain'],
  'Lat Pulldown': ['compound', 'back'],
  'Seated Row': ['compound', 'back'],
  'Low Row': ['compound', 'back'],
  'Plate-Loaded Row': ['compound', 'back'],
  'Chest Press': ['compound', 'chest'],
  'Incline Chest Press': ['compound', 'chest'],
  'Shoulder Press': ['compound', 'shoulders'],
  'Triceps Press': ['compound', 'triceps'],
  'Seated Leg Curl': ['isolation', 'hamstrings'],
  'Prone Leg Curl': ['isolation', 'hamstrings'],
  'Leg Extension': ['isolation', 'quads'],
  'Hip Abductor': ['isolation', 'glutes'],
  'Hip Adductor': ['isolation', 'adductors'],
  'Rear Kick': ['isolation', 'glutes'],
  'Calf Raise': ['isolation', 'calves'],
  'Cable Lateral Raise': ['isolation', 'side delts'],
  'Lateral Raise Machine': ['isolation', 'side delts'],
  'Seated Dumbbell Lateral Raise': ['isolation', 'side delts'],
  'Seated Dumbbell Front Raise': ['isolation', 'front delts'],
  'Rear Delt Fly': ['isolation', 'rear delts'],
  'Biceps Curl': ['isolation', 'biceps'],
  'Biceps Curl Machine': ['isolation', 'biceps'],
  'Bayesian Curl': ['isolation', 'biceps'],
  'Hammer Curl': ['isolation', 'biceps'],
  'Kneeling Cable Crunch': ['core', 'abs'],
  'Seated Cable Crunch': ['core', 'abs'],
  "Farmer's Walk": ['compound', 'grip/core'],
};

export const KNOWN_BRANDS = ['Life Fitness', 'Precor', 'Technogym', 'Booty Builder', 'Hammer Strength', 'Matrix', 'Cybex', 'Nautilus', 'Panatta', 'Gym80'];

export const REST_DEFAULT_SEC = { compound: 150, isolation: 105, core: 90 };

export function categoryOf(name) {
  return EXERCISE_CATALOG[name]?.[0] ?? 'isolation';
}
