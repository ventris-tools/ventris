// Reads the kind of signal a channel carries from its label. Only labels that name EEG
// count as EEG, so the belts, microphones and sensors of a sleep study stay out of EEG
// measures. The EDF+ specification lists the standard kinds, and the rest of these
// names come from clinical and sleep recordings.

const OTHER_KINDS = [
  ['EOG', /^(?:[HV]?EOG\w*|LOC|ROC)$/],
  ['EMG', /^(?:EMG\w*|CHIN\w*|LEGS?\d*|[LR]LEG|TIB\w*|LAT|RAT)$/],
  ['ECG', /^(?:ECG\w*|EKG\w*)$/],
  [
    'Other',
    /^(?:ERG|MEG|MCG|EP|TEMP(?!ORAL)\w*|RESP\w*|SAO2|SPO2|LIGHT|SOUND|EVENT\w*|MARKER\w*|STATUS|TRIG\w*|ACC\w*|GYRO\w*|PHOTIC|IBI|BURSTS?|SUPPR|SNORE|ABD\w*|THOR\w*|CHEST|NASAL|AIRFLOW|FLOW|PRESSURE|PLETH\w*|POS|POSITION|HR|PULSE|DC\d*|GSR|EDA|BP|CO2|ETCO2|CPAP)$/,
  ],
];

// E1 and E2 are eye channels in sleep montages, where they pair with a mastoid.
const SLEEP_EOG = /^E[12][^A-Z0-9]+[AM][12]\b/;

// The 10-20, 10-10 and 10-5 systems, with mastoids and earlobes.
const ELECTRODE =
  /^(?:N|FP|AFP|AFF|AF|FFC|FFT|FF|FCC|FC|FTT|FT|F|CCP|CPP|CP|C|TTP|TPP|TP|T|PPO|POO|PO|PP|P|OI|O|I|A|M)(?:Z|\d{1,2}H?)$/;

const REGION = /^(?:FRONTAL|CENTRAL|PARIETAL|OCCIPITAL|TEMPORAL)$/;

// A numbered label says nothing about the signal, and EEG systems often write them.
const NUMBERED = /^(?:CH|CHAN|CHANNEL|SIGNAL|SIG|E)?[\s_-]*\d+$/;

export function channelType(label) {
  const name = label.trim().toUpperCase();
  const words = name.split(/[^A-Z0-9]+/).filter(Boolean);

  if (SLEEP_EOG.test(name)) return 'EOG';
  for (const [kind, pattern] of OTHER_KINDS) {
    if (words.some((word) => pattern.test(word))) return kind;
  }
  const named =
    words.includes('EEG') ||
    ELECTRODE.test(words[0]) ||
    words.some((word) => REGION.test(word)) ||
    NUMBERED.test(name);
  return named ? 'EEG' : 'Other';
}

export const isEeg = ({ label }) => channelType(label) === 'EEG';
