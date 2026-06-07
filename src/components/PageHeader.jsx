import logoBlack from '../assets/ai-logo-black.png';
import typoBlack from '../assets/ai-typo-black.png';

export default function PageHeader({ step, title, subtitle, pills }) {
  return (
    <div className="page-header">
      <div className="ph-left">
        <div className="ph-step">{step}</div>
        <div className="ph-title">{title}</div>
        <div className="ph-sub">{subtitle}</div>
      </div>
      <div className="ph-right">
        <div className="step-pills">
          {pills.map((state, i) => (
            <div key={i} className={`step-pill ${state || ''}`} />
          ))}
        </div>
        <div className="ph-logo">
          <div className="ph-logo-icon">
            <img src={logoBlack} alt="Afterimage mark" />
          </div>
          <div className="ph-logo-text">
            <img src={typoBlack} alt="Afterimage" />
          </div>
        </div>
      </div>
    </div>
  );
}
