import 'expo-router/entry';
import TrackPlayer from 'react-native-track-player';

TrackPlayer.registerPlaybackService(() => require('./service'));