export default function Flash({ on }) {
  return <div className={`flash ${on ? 'on' : ''}`} />;
}
