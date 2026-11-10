// Muscles for weekly set counts. Each exercise has one primary muscle (1 set per
// working set) and any secondary muscles (½ each). The lifter can change them.
export const MUSCLES = [
  'chest', 'back', 'lower back', 'front delts', 'side delts', 'rear delts', 'biceps', 'triceps',
  'forearms', 'abs', 'quads', 'hamstrings', 'glutes', 'adductors', 'calves',
];

export const DEFAULT_TARGET = [10, 20];

// [primary, secondaries]
export const DEFAULT_MUSCLES = {
  'Seated Leg Press': ['quads', ['glutes', 'adductors']],
  'Hack Squat': ['quads', ['glutes', 'adductors']],
  'Hip Thrust': ['glutes', ['hamstrings']],
  'Deadlift': ['glutes', ['hamstrings', 'lower back', 'forearms']],
  'Lat Pulldown': ['back', ['biceps', 'rear delts']],
  'Seated Row': ['back', ['biceps', 'rear delts']],
  'Low Row': ['back', ['biceps', 'rear delts']],
  'Plate-Loaded Row': ['back', ['biceps', 'rear delts']],
  'Chest Press': ['chest', ['front delts', 'triceps']],
  'Incline Chest Press': ['chest', ['front delts', 'triceps']],
  'Shoulder Press': ['front delts', ['side delts', 'triceps']],
  'Triceps Press': ['triceps', ['chest', 'front delts']],
  'Seated Leg Curl': ['hamstrings', []],
  'Prone Leg Curl': ['hamstrings', []],
  'Leg Extension': ['quads', []],
  'Hip Abductor': ['glutes', []],
  'Hip Adductor': ['adductors', []],
  'Rear Kick': ['glutes', ['hamstrings']],
  'Calf Raise': ['calves', []],
  'Cable Lateral Raise': ['side delts', []],
  'Lateral Raise Machine': ['side delts', []],
  'Seated Dumbbell Lateral Raise': ['side delts', []],
  'Seated Dumbbell Front Raise': ['front delts', []],
  'Rear Delt Fly': ['rear delts', []],
  'Biceps Curl': ['biceps', []],
  'Biceps Curl Machine': ['biceps', []],
  'Bayesian Curl': ['biceps', []],
  'Hammer Curl': ['biceps', ['forearms']],
  'Kneeling Cable Crunch': ['abs', []],
  'Seated Cable Crunch': ['abs', []],
  "Farmer's Walk": ['forearms', ['abs']],
};
