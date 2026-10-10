import React from 'react';
import {View, Text, ScrollView, TouchableOpacity} from 'react-native';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Filet de sécurité : en release, une erreur de rendu fait planter l'app
 * sans explication. Ici on affiche l'erreur à l'écran + un bouton Relancer.
 * (Les erreurs fatales sont aussi capturées côté natif par CrashReporter.)
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = {error: null};

  static getDerivedStateFromError(error: Error): State {
    return {error};
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // La trace complète remonte au CrashReporter natif via JSException.
    console.warn('ErrorBoundary:', error.message, info.componentStack);
  }

  private restart = () => {
    this.setState({error: null});
  };

  render() {
    if (this.state.error) {
      const err = this.state.error;
      const msg =
        (err && (err.stack || err.message)) || String(err);
      return (
        <View
          style={{
            flex: 1,
            backgroundColor: '#05070D',
            padding: 20,
            paddingTop: 64,
          }}>
          <Text style={{color: '#FFB74D', fontSize: 18, fontWeight: '700', marginBottom: 6}}>
            Une erreur est survenue
          </Text>
          <Text style={{color: '#9AA0B0', fontSize: 12, marginBottom: 14}}>
            An error occurred — vous pouvez relancer l&apos;application.
          </Text>
          <ScrollView
            style={{
              flex: 1,
              backgroundColor: '#0B0F1A',
              borderRadius: 8,
              padding: 10,
            }}>
            <Text style={{color: '#C0C6D4', fontFamily: 'monospace', fontSize: 10}}>
              {msg}
            </Text>
          </ScrollView>
          <TouchableOpacity
            onPress={this.restart}
            style={{
              marginTop: 16,
              backgroundColor: '#FFB74D',
              borderRadius: 8,
              padding: 14,
              alignItems: 'center',
            }}>
            <Text style={{color: '#05070D', fontWeight: '700'}}>Relancer l&apos;application</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}
