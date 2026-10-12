/**
 * Catalogue des services de télescopes distants (v2.9.0).
 *
 * Trois familles, comme décrit par l'utilisateur :
 *  - 'live'   : plateformes axées sur l'expérience en direct (flux vidéo + pilotage)
 *  - 'public' : observatoires publics gratuits (contrôle asynchrone, images)
 *  - 'pro'    : réseaux professionnels et éducatifs (pilotage avancé)
 *
 * Module 100 % pur TypeScript (testable sans RN). La liste est conçue pour
 * être complétée : ajouter une entrée ici suffit à l'afficher dans l'onglet
 * Services (menu déroulant, encadré récapitulatif, compte, session WebView).
 */

export type RemoteCategory = 'live' | 'public' | 'pro';
export type RemoteVideo = 'live' | 'images' | 'none';

export interface RemoteQuickLink {
  /** Libellé neutre (souvent un nom propre : WebTV, Missions…). */
  label: string;
  url: string;
}

export interface RemoteService {
  id: string;
  name: string;
  category: RemoteCategory;
  operator: string;
  /** Site principal. */
  site: string;
  /** Page de connexion (le remplissage automatique y est tenté). */
  loginUrl: string;
  /** Page de création de compte ; si absente, l'onglet ouvre le site. */
  signupUrl?: string;
  /** Accès de base gratuit (sinon abonnement). */
  free: boolean;
  /** Pilotage temps réel (sinon file d'attente / asynchrone). */
  realtime: boolean;
  video: RemoteVideo;
  /** Un compte est nécessaire pour l'usage de base. */
  needsAccount: boolean;
  summaryFr: string;
  summaryEn: string;
  featuresFr: string[];
  featuresEn: string[];
  quickLinks: RemoteQuickLink[];
}

export const CATEGORY_ORDER: RemoteCategory[] = ['live', 'public', 'pro'];

export const REMOTE_SERVICES: RemoteService[] = [
  {
    id: 'vtp',
    name: 'The Virtual Telescope Project',
    category: 'live',
    operator: 'Gianluca Masi — Italie',
    site: 'https://www.virtualtelescope.eu',
    loginUrl: 'https://www.virtualtelescope.eu/wp-login.php',
    free: true,
    realtime: true,
    video: 'live',
    needsAccount: false,
    summaryFr:
      "WebTV d'observation animée par l'astrophysicien Gianluca Masi : sessions " +
      'en temps réel et couverture en direct des grands événements célestes ' +
      "(astéroïdes géocroiseurs, éclipses, comètes). Aucun compte n'est requis " +
      'pour suivre les diffusions.',
    summaryEn:
      'WebTV run by astrophysicist Gianluca Masi: real-time sessions and live ' +
      'coverage of major sky events (near-Earth asteroids, eclipses, comets). ' +
      'No account is required to watch the broadcasts.',
    featuresFr: [
      "Sessions d'observation en temps réel sur la WebTV",
      'Direct des événements : astéroïdes géocroiseurs, éclipses, comètes',
      'Commentaires d’expert et cartes du ciel pendant la diffusion',
      'Aucun compte requis',
      'Replays et archives des événements passés',
    ],
    featuresEn: [
      'Real-time observing sessions on the WebTV',
      'Live events: near-Earth asteroids, eclipses, comets',
      'Expert commentary and sky charts during broadcasts',
      'No account required',
      'Replays and archives of past events',
    ],
    quickLinks: [
      {label: 'WebTV', url: 'https://www.virtualtelescope.eu/webtv/'},
      {label: 'Événements', url: 'https://www.virtualtelescope.eu/category/events/'},
    ],
  },
  {
    id: 'slooh',
    name: 'Slooh',
    category: 'live',
    operator: 'Slooh Ltd. — Canaries, Chili, Australie',
    site: 'https://www.slooh.com',
    loginUrl: 'https://www.slooh.com/login',
    free: false,
    realtime: true,
    video: 'live',
    needsAccount: true,
    summaryFr:
      "L'une des plateformes les plus abouties : pilotez des télescopes " +
      'robotiques professionnels implantés aux îles Canaries, au Chili et en ' +
      'Australie. Le service repose sur un abonnement, mais de très fréquents ' +
      'événements de vulgarisation sont gratuits et ouverts au public.',
    summaryEn:
      'One of the most mature platforms: control professional robotic ' +
      'telescopes in the Canary Islands, Chile and Australia. The service is ' +
      'subscription-based, yet very frequent outreach events are free and ' +
      'open to everyone.',
    featuresFr: [
      'Pilotage de télescopes robotiques professionnels (Canaries, Chili, Australie)',
      'Flux visuels en direct de vos sessions',
      'Événements de vulgarisation très fréquents, gratuits et ouverts',
      'Missions guidées et parcours de progression',
      'Accès complet par abonnement',
    ],
    featuresEn: [
      'Control professional robotic telescopes (Canary Islands, Chile, Australia)',
      'Live visual feeds of your sessions',
      'Very frequent free, open outreach events',
      'Guided missions and progression tracks',
      'Full access by subscription',
    ],
    quickLinks: [
      {label: 'Accueil', url: 'https://www.slooh.com'},
      {label: 'Connexion', url: 'https://www.slooh.com/login'},
    ],
  },
  {
    id: 'telescope.org',
    name: 'Telescope.org (Open University)',
    category: 'public',
    operator: 'Open University — Tenerife (Espagne)',
    site: 'https://www.telescope.org',
    loginUrl: 'https://www.telescope.org',
    free: true,
    realtime: false,
    video: 'images',
    needsAccount: true,
    summaryFr:
      "Observatoire robotique géré par l'Open University, héritier du Bradford " +
      "Robotic Telescope : soumettez vos cibles d'observation via une file " +
      "d'attente, puis éditez et téléchargez les images prises à Tenerife. " +
      "L'accès est gratuit (compte requis).",
    summaryEn:
      'Robotic observatory run by the Open University, heir to the Bradford ' +
      'Robotic Telescope: submit your targets through a queue, then edit and ' +
      'download images taken in Tenerife. Free access (account required).',
    featuresFr: [
      'Contrôle de télescopes robotiques à Tenerife',
      "Soumission de cibles via une file d'attente",
      'Édition et téléchargement des images générées',
      'Accès gratuit — compte requis',
      'Héritier du Bradford Robotic Telescope',
    ],
    featuresEn: [
      'Control robotic telescopes in Tenerife',
      'Target submission through a queue',
      'Edit and download the generated images',
      'Free access — account required',
      'Heir to the Bradford Robotic Telescope',
    ],
    quickLinks: [
      {label: 'Accueil', url: 'https://www.telescope.org'},
    ],
  },
  {
    id: 'microobservatory',
    name: 'MicroObservatory (Harvard / NASA)',
    category: 'public',
    operator: 'Harvard-Smithsonian CfA / NASA — États-Unis',
    site: 'https://mo-www.cfa.harvard.edu/OWN/',
    loginUrl: 'https://mo-www.cfa.harvard.edu/OWN/',
    free: true,
    realtime: false,
    video: 'images',
    needsAccount: false,
    summaryFr:
      'Réseau de télescopes robotiques intégralement gratuit, sans installation ' +
      'complexe. Fonctionnement asynchrone : choisissez une cible et recevez ' +
      "l'image capturée par courriel peu après. Pas de pilotage temps réel ni " +
      'de flux vidéo — idéal pour découvrir l’acquisition astronomique.',
    summaryEn:
      'A fully free network of robotic telescopes, no complex setup. ' +
      'Asynchronous: choose a target and receive the captured image by email ' +
      'shortly after. No real-time control or video feed — great to learn ' +
      'astronomical imaging.',
    featuresFr: [
      'Réseau NASA / Harvard entièrement gratuit',
      'Asynchrone : requête de cible, image reçue par courriel',
      'Aucune installation complexe',
      'Portail « Observing With NASA »',
      "Idéal pour apprendre (filtres, poses, empilement)",
    ],
    featuresEn: [
      'NASA / Harvard network, entirely free',
      'Asynchronous: request a target, image emailed back',
      'No complex setup',
      '“Observing With NASA” portal',
      'Great for learning (filters, exposures, stacking)',
    ],
    quickLinks: [
      {label: 'Observing With NASA', url: 'https://mo-www.cfa.harvard.edu/OWN/'},
      {label: 'MicroObservatory', url: 'https://mo-www.cfa.harvard.edu/microobs/'},
    ],
  },
  {
    id: 'itelescope',
    name: 'iTelescope',
    category: 'pro',
    operator: 'iTelescope.Net — Espagne, Australie, États-Unis',
    site: 'https://www.itelescope.net',
    loginUrl: 'https://members.itelescope.net',
    free: false,
    realtime: true,
    video: 'images',
    needsAccount: true,
    summaryFr:
      "Acteur historique de l'astronomie sur internet : contrôle direct et en " +
      'temps réel de sa flotte mondiale de télescopes professionnels. ' +
      "L'accès complet est réservé aux abonnés ; des périodes d'essai et des " +
      'instruments de découverte sont parfois proposés aux débutants.',
    summaryEn:
      'A pioneer of internet astronomy: direct, real-time control of a ' +
      'worldwide fleet of professional telescopes. Full access is for ' +
      'subscribers; trials and discovery instruments are sometimes offered ' +
      'to beginners.',
    featuresFr: [
      'Contrôle direct et temps réel de la flotte',
      'Télescopes CCD professionnels répartis sur le globe',
      "Planification de missions et réservation d'instruments",
      'Qualité de recherche (CCD refroidis, filtres)',
      'Abonnement — essais et instruments de découverte possibles',
    ],
    featuresEn: [
      'Direct, real-time fleet control',
      'Professional CCD telescopes across the globe',
      'Mission planning and instrument reservation',
      'Research grade (cooled CCDs, filters)',
      'Subscription — trials and discovery scopes available',
    ],
    quickLinks: [
      {label: 'Espace membre', url: 'https://members.itelescope.net'},
      {label: 'Accueil', url: 'https://www.itelescope.net'},
    ],
  },
  {
    id: 'skynet',
    name: 'Skynet (UNC Chapel Hill)',
    category: 'pro',
    operator: 'University of North Carolina — États-Unis',
    site: 'https://skynet.unc.edu',
    loginUrl: 'https://skynet.unc.edu',
    free: true,
    realtime: true,
    video: 'images',
    needsAccount: true,
    summaryFr:
      "Réseau connectant ses utilisateurs à l'une des plus grandes flottes " +
      'mondiales de télescopes robotiques. Très orienté vers les programmes ' +
      "éducatifs et universitaires, il permet un véritable pilotage à " +
      "distance pour l'enseignement de l'astronomie. Accès gratuit à visée " +
      'éducative (compte requis).',
    summaryEn:
      'A network connecting users to one of the largest fleets of robotic ' +
      'telescopes worldwide. Strongly oriented toward educational and ' +
      'university programs, it offers true remote control for teaching ' +
      'astronomy. Free educational access (account required).',
    featuresFr: [
      "L'une des plus grandes flottes mondiales de télescopes robotiques",
      "Véritable pilotage à distance (file d'attente d'observations)",
      'Orienté enseignement et recherche universitaire',
      "Traitement d'images avec l'outil Afterglow",
      'Accès éducatif gratuit — compte requis',
    ],
    featuresEn: [
      'One of the largest robotic telescope fleets worldwide',
      'True remote control (observation queue)',
      'Teaching and university research oriented',
      'Image processing with the Afterglow tool',
      'Free educational access — account required',
    ],
    quickLinks: [
      {label: 'Accueil', url: 'https://skynet.unc.edu'},
    ],
  },
  {
    id: 'telescope-live',
    name: 'Telescope Live',
    category: 'pro',
    operator: 'Telescope Live — Espagne, Chili, Australie',
    site: 'https://telescope.live',
    loginUrl: 'https://telescope.live',
    free: false,
    realtime: false,
    video: 'images',
    needsAccount: true,
    summaryFr:
      'Flotte de télescopes haut de gamme (0,4 à 1 m) avec observations en un ' +
      'clic ou planifiées, données brutes FITS téléchargeables et outils de ' +
      'traitement intégrés. Par abonnement, avec des tutoriels complets pour ' +
      'progresser en traitement d’images.',
    summaryEn:
      'High-end telescope fleet (0.4 to 1 m) with one-click or planned ' +
      'observations, downloadable FITS raw data and integrated processing ' +
      'tools. Subscription-based, with full tutorials to progress in image ' +
      'processing.',
    featuresFr: [
      'Télescopes 0,4 à 1 m répartis dans les deux hémisphères',
      'Observations en un clic ou planifiées',
      'Données brutes FITS + traitement intégré',
      'Tutoriels et galeries communautaires',
      'Par abonnement',
    ],
    featuresEn: [
      '0.4–1 m telescopes across both hemispheres',
      'One-click or planned observations',
      'Raw FITS data + integrated processing',
      'Tutorials and community galleries',
      'Subscription-based',
    ],
    quickLinks: [
      {label: 'Accueil', url: 'https://telescope.live'},
    ],
  },
  {
    id: 'lco',
    name: 'Las Cumbres Observatory (éducation)',
    category: 'public',
    operator: 'Las Cumbres Observatory — réseau global',
    site: 'https://lco.global',
    loginUrl: 'https://auth.lco.global/login/',
    free: true,
    realtime: false,
    video: 'images',
    needsAccount: true,
    summaryFr:
      'Réseau mondial de télescopes robotiques professionnels. Son programme ' +
      "éducatif permet aux classes et au public de soumettre des demandes " +
      "d'observation dans une file d'attente, avec des outils d'analyse en " +
      'ligne. Compte éducatif gratuit.',
    summaryEn:
      'A global network of professional robotic telescopes. Its education ' +
      'program lets classrooms and the public submit observation requests ' +
      'through a queue, with online analysis tools. Free education account.',
    featuresFr: [
      'Réseau mondial de télescopes robotiques professionnels',
      "Programme éducatif gratuit (file d'attente de demandes)",
      "Outils d'analyse en ligne",
      'Images science de qualité recherche',
      'Compte éducatif gratuit',
    ],
    featuresEn: [
      'Global network of professional robotic telescopes',
      'Free education program (request queue)',
      'Online analysis tools',
      'Research-grade science images',
      'Free education account',
    ],
    quickLinks: [
      {label: 'Éducation', url: 'https://lco.global/education/'},
      {label: 'Accueil', url: 'https://lco.global'},
    ],
  },
];

export function findService(id: string | null): RemoteService | null {
  if (!id) return null;
  return REMOTE_SERVICES.find((s) => s.id === id) ?? null;
}
