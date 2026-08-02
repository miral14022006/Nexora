import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useStore } from "./store.js";
import { connectSocket, disconnectSocket } from "./ws.js";
import Landing from "./pages/Landing.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import SignupPage from "./pages/SignupPage.jsx";
import ChatPage from "./pages/ChatPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";

export default function App() {
  const session = useStore((s) => s.session);
  const user = useStore((s) => s.user);

  useEffect(() => {
    if (session?.user && !user) {
      useStore.getState().setUser(session.user);
    }
  }, [session, user]);

  useEffect(() => {
    if (session?.accessToken) {
      connectSocket();
      return () => disconnectSocket();
    }
  }, [session?.accessToken]);

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/app" element={<ChatPage />} />
      <Route path="/app/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
